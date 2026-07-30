// Local oxlint JS plugin: a port of ESLint core's `id-length` rule, which
// oxlint does not ship natively. oxlint loads it through jsPlugins; Node
// strips the type-only imports at load time. Same report map and option shape
// as ESLint (min/max/properties/exceptions/exceptionPatterns), so the config
// reads exactly like the ESLint rule. TypeScript type-land nodes
// (TSTypeParameter, TSTypeReference, type annotations) are absent from the
// report map, so generic parameters and type names are never flagged.
import type { Rule } from "eslint";

type AstNode = {
  type: string;
  name?: string;
  value?: unknown;
  computed?: boolean;
  range?: [number, number];
  start?: number;
  end?: number;
  parent?: AstNode;
  left?: AstNode;
  id?: AstNode;
  key?: AstNode;
  imported?: AstNode;
  local?: AstNode;
};

const moduleExportName = (node: AstNode | undefined): unknown =>
  node && node.type === "Identifier" ? node.name : node && node.value;

interface IdLengthOptions {
  min?: number;
  max?: number;
  properties?: "always" | "never";
  exceptions?: string[];
  exceptionPatterns?: string[];
}

const idLength: Rule.RuleModule = {
  meta: {
    type: "suggestion",
    docs: { description: "Enforce a minimum identifier length" },
    schema: [
      {
        type: "object",
        properties: {
          min: { type: "integer" },
          max: { type: "integer" },
          properties: { enum: ["always", "never"] },
          exceptions: { type: "array", items: { type: "string" } },
          exceptionPatterns: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      tooShort: "Identifier name '{{name}}' is too short (< {{min}}).",
      tooLong: "Identifier name '{{name}}' is too long (> {{max}}).",
    },
  },
  create(context) {
    const options = (context.options[0] ?? {}) as IdLengthOptions;
    const minLength = options.min ?? 2;
    const maxLength = options.max ?? Infinity;
    const properties = options.properties !== "never";
    const exceptions = new Set(options.exceptions ?? []);
    const exceptionPatterns = (options.exceptionPatterns ?? []).map(
      (pattern) => new RegExp(pattern, "u"),
    );

    // Parent node types whose child identifier introduces or renames a binding.
    // A `true` value always reports; a function decides per node. Type-land
    // parents are deliberately absent, so type names stay exempt.
    const supported: Record<string, boolean | ((parent: AstNode, node: AstNode) => boolean)> = {
      MemberExpression:
        properties &&
        ((parent) =>
          !parent.computed &&
          ((parent.parent!.left === parent && parent.parent!.type === "AssignmentExpression") ||
            (parent.parent!.type === "Property" &&
              (parent.parent as AstNode & { value?: AstNode }).value === parent &&
              parent.parent!.parent!.type === "ObjectPattern" &&
              parent.parent!.parent!.parent!.left === parent.parent!.parent))),
      AssignmentPattern: (parent, node) => parent.left === node,
      VariableDeclarator: (parent, node) => parent.id === node,
      Property(parent, node) {
        const property = parent as AstNode & { value?: AstNode };
        if (parent.parent!.type === "ObjectPattern") {
          const keyAndValueSame = property.value!.name === parent.key!.name;
          return (
            (!keyAndValueSame && property.value === node) ||
            (keyAndValueSame && parent.key === node && properties)
          );
        }
        return properties && !parent.computed && parent.key!.name === node.name;
      },
      ImportSpecifier: (parent, node) =>
        parent.local === node && moduleExportName(parent.imported) !== moduleExportName(parent.local),
      ImportDefaultSpecifier: true,
      ImportNamespaceSpecifier: true,
      RestElement: true,
      FunctionExpression: true,
      ArrowFunctionExpression: true,
      ClassDeclaration: true,
      FunctionDeclaration: true,
      MethodDefinition: true,
      PropertyDefinition: true,
      CatchClause: true,
      ArrayPattern: true,
    };

    const reported = new Set<string>();

    const check = (node: AstNode): void => {
      const name = node.name ?? "";
      const parent = node.parent!;
      const length = name.length;
      const isShort = length < minLength;
      const isLong = length > maxLength;

      if (
        !(isShort || isLong) ||
        exceptions.has(name) ||
        exceptionPatterns.some((pattern) => pattern.test(name))
      ) {
        return;
      }

      const rule = supported[parent.type];
      const key = node.range ? node.range.toString() : `${node.start}:${node.end}`;

      if (rule && !reported.has(key) && (rule === true || rule(parent, node))) {
        reported.add(key);
        context.report({
          node: node as unknown as Rule.Node,
          messageId: isShort ? "tooShort" : "tooLong",
          data: { name, min: String(minLength), max: String(maxLength) },
        });
      }
    };

    return {
      Identifier: check as never,
      PrivateIdentifier: check as never,
    };
  },
};

const plugin = {
  meta: { name: "local", namespace: "local" },
  rules: { "id-length": idLength },
};

export const { meta, rules } = plugin;
export default plugin;
