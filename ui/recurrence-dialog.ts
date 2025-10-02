import { crayon } from "https://deno.land/x/crayon@3.3.3/mod.ts";
import { clamp, Computed, Tui } from "https://deno.land/x/tui@2.1.11/mod.ts";
import { Box } from "https://deno.land/x/tui@2.1.11/src/components/box.ts";
import { Frame } from "https://deno.land/x/tui@2.1.11/src/components/frame.ts";
import { Text } from "https://deno.land/x/tui@2.1.11/src/components/text.ts";
import { List } from "./list.ts";
import { keepComponentFocussed } from "./tui-helpers.ts";

/**
 * Displays a recurrence dialog and returns a Promise that resolves with the selected recurrence rule.
 * The recurrence rule can be one of 'd' (day), 'w' (week), 'm' (month), or 'y' (year).
 * @param title The title of the dialog.
 * @param parent The parent Tui component.
 * @returns A Promise that resolves with the selected recurrence rule ('d', 'w', 'm', or 'y').
 */
type RecurrenceRule = "d" | "w" | "m" | "y";

interface RecurrenceOption {
  rule: RecurrenceRule;
  text: string;
}

export default (title: string, parent: Tui): Promise<RecurrenceRule> => {
  const options: RecurrenceOption[] = [
    { rule: "d", text: "Every day" },
    { rule: "w", text: "Every week" },
    { rule: "m", text: "Every month" },
    { rule: "y", text: "Every year" },
  ];

  const box = new Box({
    parent: parent,
    theme: {
      base: crayon.bgBlack.white,
    },
    rectangle: new Computed(() => {
      let width = clamp(
        clamp(parent.rectangle.value.width / 2, 20, 60),
        0,
        parent.rectangle.value.width,
      );
      if (width % 2 !== 0) {
        // Adjust the value to make it even
        width = Math.floor(width / 2) * 2;
      }
      const height = 2 + options.length;
      return {
        column: Math.floor((parent.rectangle.value.width - width) / 2),
        row: Math.floor((parent.rectangle.value.height - height) / 2),
        height,
        width,
      };
    }),
    zIndex: 5,
  });

  const frame = new Frame({
    parent: box,
    charMap: "sharp",
    theme: {
      base: crayon.bgBlack.white,
    },
    rectangle: box.rectangle,
    zIndex: 5,
  });

  const textBox = new Text({
    parent: box,
    text: `| ${title} |`,
    theme: {
      base: crayon.bgBlack.white,
    },
    rectangle: new Computed(() => ({
      column: box.rectangle.value.column + 2,
      row: box.rectangle.value.row - 1,
    })),
    zIndex: 6,
  });
  return new Promise((resolve, reject) => {
    const list = new List({
      parent: frame,
      theme: {
        base: crayon.bgBlack.white,
        frame: { base: crayon.bgBlack },
        selectedRow: {
          base: crayon.bold.bgBlue.white,
          focused: crayon.bold.bgWhite.black,
          active: crayon.bold.bgWhite.black,
        },
      },
      rectangle: {
        column: frame.rectangle.value.column + 1,
        row: frame.rectangle.value.row,
        width: frame.rectangle.value.width - 2,
        height: options.length,
      },
      data: options.map((x) => [x.text]),
      zIndex: 7,
      interactCallback: () => {
        const selectedOption = options[list.selectedRow.peek()!];
        resolve(selectedOption.rule);
        destroy();
      },
    });

    const destroy = () => {
      box.destroy();
      textBox.destroy();
      list.destroy();
    };

    keepComponentFocussed(list);

    list.on("keyPress", ({ key, ctrl, meta, shift }) => {
      if (ctrl || meta || shift) return;

      switch (key) {
        case "escape":
          destroy();
          reject("Canceled");
          break;
        case "return":
          {
            const selectedOption = options[list.selectedRow.peek()!];
            resolve(selectedOption.rule);
            destroy();
          }
          break;
      }
    });
  });
};
