// A module whose run() throws, to exercise the record-failure exit path. The --target node lane
// imports and profiles run() in this process (no browser), so this reproduces a real record failure
// browser-free and deterministically.
export async function run() {
  throw new Error("intentional run failure for the exit-code test");
}
