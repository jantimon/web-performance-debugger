// The `react` addon's in-page probe: a minimal `__REACT_DEVTOOLS_GLOBAL_HOOK__` installed BEFORE
// react-dom runs (via evaluateOnNewDocument, so it re-arms on every navigation). It yields build-
// INDEPENDENT, exact-tier facts with no fiber walk: React registers a reconciler through `hook.inject`
// carrying `version`/`rendererPackageName`/`bundleType` [source: bippy README], and `onCommitFiberRoot`
// fires once per committed update [measured: 5 clicks = 5 commits on dev AND production]. See
// docs/dev/react-attribution.md#framework-detection-metadata-the-pre-load-global-hook.
//
// `installReactHook` is serialized into the page by Puppeteer, so it must be SELF-CONTAINED: it
// references no module-level binding and only touches `window`. The descriptive-name rule holds here
// too (names do not affect serialization).

/**
 * Install the mini-hook and the per-step commit channel on `window`. Idempotent-ish: if a real hook
 * already exists (DevTools), it augments rather than replaces it. Stashes detection facts on
 * `window.__wpdAddons.react` and wraps `window.__wpdAddonStepReset`/`Read` so a driver step reads its
 * own commit delta.
 */
export function installReactHook(): void {
  const win = window as unknown as Record<string, any>;
  win.__wpdReactCommits = 0;

  const recordRenderer = (renderer: any): void => {
    try {
      const store = (win.__wpdAddons = win.__wpdAddons || {});
      const facts = (store.react = store.react || { detected: false });
      facts.detected = true;
      if (renderer && renderer.version) facts.version = String(renderer.version);
      if (renderer && renderer.rendererPackageName)
        facts.rendererPackageName = String(renderer.rendererPackageName);
      if (renderer && typeof renderer.bundleType === "number")
        facts.build = renderer.bundleType === 1 ? "development" : "production";
    } catch (error) {
      void error;
    }
  };

  // Seed a detected:false fact so ABSENCE is honest even if React never injects (never a fabricated
  // "detected" and never a silent gap).
  const store = (win.__wpdAddons = win.__wpdAddons || {});
  if (!store.react) store.react = { detected: false };

  // Hydration-mismatch signal. React's DEFAULT onRecoverableError routes through reportError, which
  // dispatches a window `error` event; a hydration mismatch fires one. Capture React-authored error
  // messages (they always link to react.dev) so enrich can classify the hydration ones; a non-React
  // error is never stored. A user-supplied onRecoverableError replaces the default and suppresses the
  // event, so this listener sees nothing then (absence is not proof of clean hydration).
  const REACT_ERROR_MARK = "react.dev/";
  const MAX_STORED_ERRORS = 25;
  const MAX_ERROR_LENGTH = 512;
  try {
    const errorStore = (win.__wpdAddons = win.__wpdAddons || {});
    const errorFacts = (errorStore.react = errorStore.react || { detected: false });
    errorFacts.hydrationErrorMessages = errorFacts.hydrationErrorMessages || [];
    win.addEventListener("error", (event: any) => {
      try {
        const source = event && event.error && event.error.message;
        const message = String(source != null ? source : (event && event.message) || "");
        if (message.indexOf(REACT_ERROR_MARK) === -1) return;
        const list = errorFacts.hydrationErrorMessages;
        if (list.length < MAX_STORED_ERRORS) list.push(message.slice(0, MAX_ERROR_LENGTH));
      } catch (error) {
        void error;
      }
    });
  } catch (error) {
    void error;
  }

  // A commit bumps BOTH the resettable per-step counter (window channel) and the cumulative run-level
  // count carried on the detection fact, so the run span reports total commits and each step its own.
  const bumpCommit = (): void => {
    win.__wpdReactCommits = (win.__wpdReactCommits || 0) + 1;
    const bumpStore = (win.__wpdAddons = win.__wpdAddons || {});
    const facts = (bumpStore.react = bumpStore.react || { detected: false });
    facts.commitCount = (facts.commitCount || 0) + 1;
  };

  const existing = win.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (existing) {
    try {
      if (existing.renderers && typeof existing.renderers.forEach === "function")
        existing.renderers.forEach((renderer: any) => recordRenderer(renderer));
    } catch (error) {
      void error;
    }
    const priorInject =
      typeof existing.inject === "function" ? existing.inject.bind(existing) : null;
    existing.inject = (renderer: any) => {
      recordRenderer(renderer);
      return priorInject ? priorInject(renderer) : 0;
    };
    const priorCommit =
      typeof existing.onCommitFiberRoot === "function"
        ? existing.onCommitFiberRoot.bind(existing)
        : null;
    existing.onCommitFiberRoot = (...commitArgs: any[]) => {
      bumpCommit();
      if (priorCommit) return priorCommit(...commitArgs);
    };
  } else {
    let nextRendererId = 1;
    const renderers = new Map<number, any>();
    win.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      supportsFiber: true,
      renderers,
      inject(renderer: any) {
        const rendererId = nextRendererId++;
        renderers.set(rendererId, renderer);
        recordRenderer(renderer);
        return rendererId;
      },
      onScheduleFiberRoot() {},
      onCommitFiberRoot() {
        bumpCommit();
      },
      onPostCommitFiberRoot() {},
      onCommitFiberUnmount() {},
      on() {},
      sub() {
        return () => {};
      },
      emit() {},
      getFiberRoots() {
        return new Set();
      },
    };
  }

  // Per-step channel (driver mode): wrap so a step's commit COUNT resets at its start and is read at
  // its flush. Composes with any other addon that installed the same wrappers (call the prior first).
  const priorReset = win.__wpdAddonStepReset;
  win.__wpdAddonStepReset = () => {
    if (typeof priorReset === "function") priorReset();
    win.__wpdReactCommits = 0;
  };
  const priorRead = win.__wpdAddonStepRead;
  win.__wpdAddonStepRead = () => {
    const base = typeof priorRead === "function" ? priorRead() || {} : {};
    base.react = { commits: win.__wpdReactCommits || 0 };
    return base;
  };
}
