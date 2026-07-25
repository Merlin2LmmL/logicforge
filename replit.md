# LogicForge

Browser-based digital logic circuit editor and simulator. Wire together gates (AND, OR, NOT, XOR, …), group them into reusable components, and simulate signal propagation — all in the browser with no backend.

## Stack
- **Vite** dev server (port 5000)
- Vanilla JS ES modules — no framework
- Canvas 2D rendering (`src/ui/renderer.js`)

## Run
```
npm run dev      # dev server on port 5000
npm run build    # production build → dist/
```

## Project layout
```
index.html          main HTML + toolbar markup
src/
  main.js           entry point — wires DOM to Editor
  style.css         all styles
  components/       built-in gate / IO / wiring definitions
  core/
    model.js        Circuit, Wire, ComponentInstance classes
    simulator.js    signal propagation
    fileformat.js   .lgf save/load (JSON)
    registry.js     component type registry
    library.js      user-defined component storage
  ui/
    editor.js       Editor class — input handling, history, actions
    renderer.js     canvas draw functions
    layout.js       pin layout, wirePath, grid helpers
    dialog.js       modal dialogs, toasts
```

## Key shortcuts
| Key | Action |
|-----|--------|
| O | Toggle orthogonal wire mode |
| R | Rotate selection |
| Del | Delete selection |
| Ctrl+Z/Y | Undo / Redo |
| Ctrl+S | Save to .lgf |
| Ctrl+O | Open .lgf |
| Space+drag | Pan |
| Scroll | Zoom |

## Orthogonal wire mode
When enabled (button in toolbar or press **O**):
- New wires are routed as L-shapes (horizontal → vertical)
- Individual wire segments can be dragged to reposition them (click and drag any segment)
- Junction dots appear wherever a source pin fans out to multiple wires, and at T-junctions
- Existing wires without waypoints continue to render as diagonal — drag their segments to straighten them

## User preferences
<!-- Add user preferences here as they come up -->
