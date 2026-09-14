/**
 * Config editor options for phones (fork, flag `phoneFixes`).
 *
 * Monaco's defaults assume a wide window and a mouse: a minimap, a folding
 * gutter and horizontal scrolling for long lines. On a ~412 px wide phone
 * those take a third of the width and long YAML lines scroll off screen
 * under the thumb. These options wrap lines, drop the minimap and gutters,
 * and widen the scrollbars so they can be dragged with a finger.
 */

import type * as monaco from "monaco-editor";

export const phoneEditorOptions: monaco.editor.IStandaloneEditorConstructionOptions =
  {
    minimap: { enabled: false },
    wordWrap: "on",
    wrappingIndent: "indent",
    folding: false,
    glyphMargin: false,
    lineNumbersMinChars: 3,
    lineDecorationsWidth: 4,
    overviewRulerLanes: 0,
    renderLineHighlight: "none",
    scrollbar: {
      verticalScrollbarSize: 14,
      horizontalScrollbarSize: 14,
      alwaysConsumeMouseWheel: false,
    },
  };
