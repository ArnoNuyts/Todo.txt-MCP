// Copyright 2023 Im-Beast. MIT license.
import {
  Component,
  ComponentOptions,
} from "https://deno.land/x/tui@2.1.11/src/component.ts";

import { BoxObject } from "https://deno.land/x/tui@2.1.11/src/canvas/box.ts";
import { TextObject } from "https://deno.land/x/tui@2.1.11/src/canvas/text.ts";

import {
  Computed,
  Signal,
} from "https://deno.land/x/tui@2.1.11/src/signals/mod.ts";
import { Theme } from "https://deno.land/x/tui@2.1.11/src/theme.ts";
import type {
  DeepPartial,
  Rectangle,
} from "https://deno.land/x/tui@2.1.11/src/types.ts";
import { clamp } from "https://deno.land/x/tui@2.1.11/src/utils/numbers.ts";
import { signalify } from "https://deno.land/x/tui@2.1.11/src/utils/signals.ts";

export interface ListTheme extends Theme {
  frame: Theme;
  header: Theme;
  selectedRow: Theme;
}

export interface ListOptions extends Omit<ComponentOptions, "rectangle"> {
  theme: DeepPartial<ListTheme, "frame" | "selectedRow">;
  rectangle: Rectangle;
  data: string[][];
  interactCallback?: () => void;
}

/**
 * Component for creating interactive table
 *
 * Rectangle's `width` gets automatically calculcated from given headers.
 *
 * You can specify each header's width explicitly or leave it out to let List to figure it out.
 *
 * @example
 * ```ts
 * new List({
 *   parent: tui,
 *   theme: {
 *     base: crayon.bgBlack.white,
 *     selectedRow: {
 *       base: crayon.bold.bgBlue.white,
 *       focused: crayon.bold.bgLightBlue.white,
 *       active: crayon.bold.bgMagenta.black,
 *     },
 *   },
 *   rectangle: {
 *     column: 1,
 *     row: 1,
 *     height: 10,
 *     width: 8,
 *   },
 *   data: [
 *     "Thomas Jeronimo",
 *     "Jeremy Wanker",
 *     "Julianne James",
 *     "Tommie Moyer",
 *     "Marta Reilly",
 *     "Bernardo Robertson",
 *     "Hershel Grant",
 *   ],
 *   zIndex: 0,
 * });
 *
 * ```
 */
export class List extends Component {
  declare theme: ListTheme;
  declare drawnObjects: {
    frame: [
      top: TextObject,
      bottom: TextObject,
      spacer: TextObject,
      left: BoxObject,
      right: BoxObject,
    ];

    header: TextObject;
    data: TextObject[];
  };

  data: Signal<string[][]>;
  selectedRow: Signal<number>;
  offsetRow: Signal<number>;
  interactCallback: (() => void) | undefined;

  constructor(options: ListOptions) {
    super(options as unknown as ComponentOptions);

    this.data = signalify(options.data, { deepObserve: true });
    this.selectedRow = new Signal(0);
    this.offsetRow = new Signal(0);
    this.interactCallback = options.interactCallback;

    this.data.subscribe((data) => {
      const dataDrawObjects = this.drawnObjects.data?.length;
      if (!dataDrawObjects) return;
      if (data.length > dataDrawObjects) {
        this.#fillDataDrawObjects();
      } else if (data.length < dataDrawObjects) {
        this.#popUnusedDataDrawObjects();
      }
    });

    this.on("keyPress", ({ key, ctrl, meta, shift }) => {
      if (ctrl || meta || shift) return;

      const { height } = this.rectangle.peek();
      const lastDataRow = this.data.peek().length - 1;

      const { selectedRow, offsetRow } = this;

      switch (key) {
        case "up":
          --selectedRow.value;
          break;
        case "down":
          ++selectedRow.value;
          break;
        case "pageup":
          selectedRow.value -= ~~(lastDataRow / 100);
          break;
        case "pagedown":
          selectedRow.value += ~~(lastDataRow / 100);
          break;
        case "home":
          selectedRow.value = 0;
          break;
        case "end":
          selectedRow.value = lastDataRow;
          break;
      }

      selectedRow.value = clamp(selectedRow.peek(), 0, lastDataRow);
      offsetRow.value = clamp(
        selectedRow.peek() - ~~(height / 2),
        0,
        lastDataRow - height,
      );
    });

    this.on("mouseEvent", (mouseEvent) => {
      if (mouseEvent.ctrl || mouseEvent.meta || mouseEvent.shift) return;
      const { y } = mouseEvent;
      const { row, height } = this.rectangle.peek();

      const lastDataRow = this.data.peek().length - 1;

      if ("scroll" in mouseEvent) {
        this.offsetRow.value = clamp(
          this.offsetRow.peek() + mouseEvent.scroll,
          0,
          lastDataRow - height,
        );
      } else if ("button" in mouseEvent && y >= row && y <= row + height) {
        const dataRow = y - row + this.offsetRow.peek();
        if (dataRow !== clamp(dataRow, 0, lastDataRow)) return;
        this.selectedRow.value = dataRow;
      }
    });
  }

  override draw(): void {
    super.draw();

    const { drawnObjects } = this;

    // Drawing data cells
    drawnObjects.data = [];
    this.#fillDataDrawObjects();
  }

  override interact(method: "mouse" | "keyboard"): void {
    const interactionInterval = Date.now() - this.lastInteraction.time;

    if (this.state.peek() === "focused" && interactionInterval < 500) {
      // Set timeout to prevent event to affect other components.
      this.interactCallback?.();
      this.state.value === "active";
    } else {
      this.state.value = "focused";
    }
    super.interact(method);
  }

  #fillDataDrawObjects(): void {
    const { canvas } = this.tui;
    const { drawnObjects } = this;

    for (
      let i = drawnObjects.data.length;
      i < this.rectangle.peek().height;
      ++i
    ) {
      const textRectangle = { column: 0, row: 0 };
      const text = new TextObject({
        canvas,
        view: this.view,
        zIndex: this.zIndex,
        style: new Computed(() => {
          const offsetRow = this.offsetRow.value;
          const selectedRow = this.selectedRow.value;
          const selectedRowStyle = this.theme.selectedRow[this.state.value];
          const style = this.style.value;
          return (i + offsetRow) === selectedRow ? selectedRowStyle : style;
        }),
        value: new Computed(() => {
          const dataRow = this.data.value[i + this.offsetRow.value];
          if (!dataRow) return "";

          let string = "";
          for (const [, dataCell] of dataRow.entries()) {
            /*if (j !== 0) {
              const padding = Math.max(0, headers[j - 1].width - textWidth(prevData) + 1);
              string += " ".repeat(padding);
            }*/
            string += dataCell;
          }

          return string.padEnd(this.rectangle.value.width, " ");
        }),
        rectangle: new Computed(() => {
          const { column, row } = this.rectangle.value;
          textRectangle.column = column;
          textRectangle.row = row + i;
          return textRectangle;
        }),
      });

      drawnObjects.data.push(text);
      text.draw();
    }
  }

  #popUnusedDataDrawObjects(): void {
    for (
      const dataCell of this.drawnObjects.data.splice(this.data.value.length)
    ) {
      dataCell.erase();
    }
  }
}
