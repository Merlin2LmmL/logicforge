# LogicForge

A browser-based digital logic circuit editor and simulator. Place gates and I/O components on a canvas, wire them together, and watch signals propagate in real time. No backend, no build step required to use it, everything runs client-side.

Live demo: https://merlin2lmml.github.io/logicforge

## Features

- **Circuit editor on an HTML canvas**: pan, zoom, grid snapping, marquee selection, multi-select, copy/paste, undo/redo.
- **Component palette** covering logic gates, I/O devices, bus/wiring utilities, and arithmetic blocks (see below for the full list).
- **Live simulation**: outputs update continuously as the circuit is edited, with a settling algorithm that resolves multi-driver conflicts and floating (unconnected) pins.
- **Two wire routing modes**: direct pin-to-pin wires, or orthogonal (Manhattan-style) wires with draggable segments and automatic junction dots at fan-outs and T-junctions.
- **Composite components**: select any subset of a circuit and group it into a reusable component with automatically generated input/output pins.
- **Code components**: define a component's behavior directly in JavaScript (inputs, persistent state, and parameters are provided to a small evaluation function) without touching the editor's source.
- **Component library**: user-defined composite and code components persist locally and appear in the palette alongside the built-in types. They can be exported to and imported from `.lgf` files for sharing.
- **Save/load**: circuits are serialized to a JSON-based `.lgf` file format that preserves component placement, parameters, state, and wire routing.

## Tech stack

- **Vite** as the dev server and build tool.
- **Vanilla JavaScript (ES modules)**, no frontend framework.
- **Canvas 2D** for all circuit rendering (`src/ui/renderer.js`).
- **localStorage** for autosave and the user component library, no server-side persistence.

## Getting started

```bash
npm install
npm run dev      # starts the dev server on port 5000
npm run build     # production build, output in dist/
```

## Project structure

```
index.html          main HTML document and toolbar markup
src/
  main.js            entry point, wires the DOM to the Editor class
  style.css           all styling
  components/         built-in component type definitions (gates, I/O, wiring)
  core/
    model.js          Circuit, Wire, and ComponentInstance data classes
    bits.js            bit-level value representation (0, 1, floating, conflict)
    simulator.js       signal propagation and settling logic
    fileformat.js      .lgf serialization/deserialization
    registry.js        component type registry
    library.js         storage for user-defined components
  ui/
    editor.js           Editor class: input handling, history, editing actions
    renderer.js          canvas drawing routines
    layout.js            pin layout, wire path computation, grid helpers
    dialog.js            modal dialogs and toast notifications
```

## Component types

Built-in components are grouped into categories (labeled in German in the UI); the palette order and category names are defined in `src/components/index.js`.

**I/O** (`io.js`): Switch, Button, Clock (configurable frequency or manual toggle), Constant, Slider (adjustable range and display format), Pull-up, Pull-down, RGB LED.

**Gates** (`gates.js`): AND, NAND, OR, NOR, XOR, XNOR (all with a configurable number of inputs and bit width), NOT, Buffer, Tri-state buffer.

**Multiplexers** (`mux.js`): Multiplexer, Demultiplexer, Priority encoder, Decoder, all with a configurable number of select bits and data width.

**Arithmetic** (`arithmetic.js`): Adder/Subtractor (two's-complement subtraction, carry in/out for cascading), Comparator (equal/less-than/greater-than).

**Memory** (`memory.js`): D flip-flop, Register, RAM (up to 1024 words, with a hex-encoded initial content preset), Counter (up/down, with terminal-count output), Shift register (left/right, serial in/out, parallel load).

**Wiring** (`wiring.js`): Splitter, Merger, Tunnel in/out (connects nets by shared name without drawing a wire between them).

**Debug** (`debug.js`): Lamp, Display (hex/decimal/binary readout), Probe, Seven-segment display, Bus watch (shows a value in all three formats at once).

**Interface** (`interface.js`): Pin In, Pin Out, used as the boundary pins of a circuit when it is turned into a composite component; they behave like a switch/probe when the circuit they belong to is simulated standalone.

**User-defined**: Composite components (built from a selected sub-circuit, with input/output pins generated automatically from the wires that crossed the selection boundary) and code components (behavior defined directly in JavaScript against `inputs`, `state`, and `params`), both created from within the editor and stored in the local component library.

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| O | Toggle orthogonal wire mode |
| R | Rotate selection |
| Del / Backspace | Delete selection |
| Ctrl+Z / Ctrl+Shift+Z | Undo / Redo |
| Ctrl+Y | Redo |
| Ctrl+S | Save circuit to .lgf |
| Ctrl+O | Open circuit from .lgf |
| Ctrl+A | Select all |
| Ctrl+C / Ctrl+V | Copy / Paste selection |
| Esc | Cancel current action (placing, wiring) and clear selection |
| Space + drag | Pan the canvas |
| Scroll | Zoom, centered on the cursor |

## Orthogonal wire mode

When enabled (toolbar button or the O key):

- New wires are routed as horizontal/vertical segments instead of a straight diagonal line.
- Individual segments of an existing wire can be dragged to reposition them.
- Junction dots are drawn wherever a source pin fans out to multiple wires, and at T-junctions where one wire's endpoint touches another wire's interior.
- Wires created while the mode was off (diagonal, no waypoints) keep rendering as straight lines until a segment is dragged, at which point they are converted to orthogonal routing.

## File format

Circuits are saved as `.lgf` files, a JSON document containing circuit metadata (name, author, description), the list of placed component instances with their type, position, rotation, parameters, and state, and the list of wires with their endpoints and routing waypoints. Individual components from the user library can also be exported to their own `.lgf` file for sharing or reuse in another project.

## Programming style and conventions

- **No build-time framework**: the UI is plain DOM manipulation and Canvas drawing, kept intentionally dependency-light.
- **Component types are data, not classes**: every gate or I/O element is registered through `registerComponentType` with a declarative shape (pin layout, parameter schema, size, initial state, and an `evaluate` function). Adding a new component type generally does not require touching the editor or renderer's control flow.
- **World versus local versus screen coordinates** are kept explicit and separate: circuit data is stored in grid-unit world coordinates, `worldToScreen`/`screenToWorld` convert to and from pixel space for input handling, and component body drawing happens inside a canvas transform already centered and scaled to the component, so drawing code should not reapply zoom or camera offsets.
- **State snapshots over incremental diffs**: undo/redo and wire-reflow-while-dragging both work by snapshotting circuit or wire state at the start of a gesture and recomputing from that snapshot each frame, rather than accumulating deltas, to avoid drift.
- **Comments and user-facing strings are in German**; this file and code identifiers are in English.
- Component and file naming favors short, purpose-named modules over large multi-purpose files, for example `layout.js` versus `renderer.js` versus `editor.js` each own a distinct concern (geometry, drawing, interaction).
