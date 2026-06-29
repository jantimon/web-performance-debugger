import { useState } from "react";

export default function App() {
  const [count, setCount] = useState(0);
  return (
    <div style={{ fontFamily: "system-ui, sans-serif", padding: "2rem" }}>
      <h1>React Counter</h1>
      <p data-testid="count" style={{ fontSize: "2rem" }}>
        {count}
      </p>
      <button data-testid="inc" onClick={() => setCount((c) => c + 1)}>
        +1
      </button>
    </div>
  );
}
