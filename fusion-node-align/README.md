# Node Align for Blackmagic Fusion

Houdini-style aligning and spacing for nodes in Fusion's Nodes (Flow) view. Works in Fusion Studio and in the Fusion page of DaVinci Resolve. The idea comes from [Houdini's "Spacing and aligning nodes"](https://www.sidefx.com/docs/houdini/network/layout.html#spacing-and-aligning-nodes).

**Anchor:** the active node (the one you clicked last, with the highlighted outline) stays where it is, and the other selected nodes line up on it. This is like Houdini's "hold A and drag from a node". If the active node isn't selected, the leftmost selected node is the anchor.

Each command is one undo step (Ctrl+Z).

| Script | Default hotkey | What it does |
|---|---|---|
| Align_Auto | Alt+A | Makes a row or a column, whichever is closer to how the nodes already sit (like the direction you drag in Houdini) |
| Align_Horizontal | Alt+H | Puts every node at the anchor's Y (one row) |
| Align_Vertical | Alt+V | Puts every node at the anchor's X (one column) |
| Straighten_Row | Alt+Shift+H | Makes one row with even gaps |
| Straighten_Column | Alt+Shift+V | Makes one column with even gaps |
| Distribute_Horizontal | Alt+D | Makes the horizontal gaps even and keeps each node's Y |
| Distribute_Vertical | Alt+Shift+D | Makes the vertical gaps even and keeps each node's X |
| Spread | Alt+S | Moves the nodes away from the anchor (gaps × 1.25) |
| Tighten | Alt+Shift+S | Moves the nodes toward the anchor (gaps × 0.8) |

Even gaps use the current average gap, but never less than one node, so nodes don't end up on top of each other.

## Install

1. Copy the `NodeAlign` folder into Fusion's `Scripts/Comp` folder:
   - **Fusion Studio, Windows:** `%APPDATA%\Blackmagic Design\Fusion\Scripts\Comp\`
   - **Resolve, Windows:** `%APPDATA%\Blackmagic Design\DaVinci Resolve\Support\Fusion\Scripts\Comp\`
   - **Fusion Studio, macOS:** `~/Library/Application Support/Blackmagic Design/Fusion/Scripts/Comp/`
   - **Resolve, macOS:** `~/Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Scripts/Comp/`
   - **Linux:** `~/.fusion/BlackmagicDesign/Fusion/Scripts/Comp/` (Resolve: `~/.local/share/DaVinciResolve/Fusion/Scripts/Comp/`)

   If you're not sure which folder is yours, use **Fusion → Fusion Settings → Path Map** and check `Scripts:`.
2. Optional hotkeys: copy `NodeAlign_Hotkeys.fu` into the `Config` folder next to `Scripts` (create it if it's missing). To change the keys, edit the file.
3. Restart Fusion or Resolve.

The scripts appear under **Script → NodeAlign** (Fusion Studio) or **Workspace → Scripts → Comp → NodeAlign** (Resolve).

## Settings

The numbers at the top of each script are `SPREAD_FACTOR`, `TIGHTEN_FACTOR`, `MIN_GAP_X` and `MIN_GAP_Y`.

## Development

The shared code is in `src/core.lua`. Run `./build.sh` to make the scripts in `NodeAlign/`, each of which works on its own.
