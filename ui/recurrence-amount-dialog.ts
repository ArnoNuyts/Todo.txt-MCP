import { readText } from "https://deno.land/x/copy_paste@v1.1.3/mod.ts";
import { crayon } from "https://deno.land/x/crayon@3.3.3/mod.ts";
import { clamp, Computed, Tui } from "https://deno.land/x/tui@2.1.11/mod.ts";
import { Box } from "https://deno.land/x/tui@2.1.11/src/components/box.ts";
import { Frame } from "https://deno.land/x/tui@2.1.11/src/components/frame.ts";
import { Input } from "https://deno.land/x/tui@2.1.11/src/components/input.ts";
import { Text } from "https://deno.land/x/tui@2.1.11/src/components/text.ts";
import { insertAt } from "https://deno.land/x/tui@2.1.11/src/utils/strings.ts";
import { keepComponentFocussed } from "./tui-helpers.ts";

export default (
  text: string,
  parent: Tui,
  recurrenceType: "d" | "w" | "m" | "y",
): Promise<string> => {
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
        width = Math.floor(width / 2) * 2; // Rounds down to nearest even number
      }

      return {
        column: Math.floor((parent.rectangle.value.width - width) / 2),
        row: Math.floor((parent.rectangle.value.height - 3) / 2),
        height: 3,
        width: width,
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

  const getTitle = (type: "d" | "w" | "m" | "y") => {
    switch (type) {
      case "d":
        return "Amount of every day";
      case "w":
        return "Amount of every week";
      case "m":
        return "Amount of every month";
      case "y":
        return "Amount of every year";
    }
  };

  const textBox = new Text({
    parent: box,
    text: `| ${getTitle(recurrenceType)} |`,
    theme: {
      base: crayon.bgBlack.white,
    },
    rectangle: new Computed(() => ({
      column: box.rectangle.value.column + 2,
      row: box.rectangle.value.row - 1,
    })),
    zIndex: 6,
  });

  const input = new Input({
    parent: frame,
    placeholder: "",
    theme: {
      value: {
        base: crayon.bgBlack,
        focused: crayon.bgBlack,
        active: crayon.bgYellow,
      },
      cursor: {
        base: crayon.bgWhite.blink,
        //focused: crayon.bgBlue,
        //active: crayon.bgYellow,
      },
    },
    rectangle: new Computed(() => ({
      column: frame.rectangle.value.column + 1,
      row: frame.rectangle.value.row,
      width: frame.rectangle.value.width - 2,
    })),
    multiCodePointSupport: true,
    zIndex: 6,
    text: text,
  });
  input.cursorPosition.value = text.length;

  keepComponentFocussed(input);

  return new Promise((resolve, reject) => {
    input.on("keyPress", async ({ key, ctrl, meta, shift }) => {
      // TODO: Support for mac shortcuts here?
      if (ctrl && key === "v") {
        // Note on windows I get extra spaces add the end. That is why trim
        const clipboardInput = (await readText()).trimEnd();
        input.text.value = insertAt(
          input.text.value,
          input.cursorPosition.value,
          clipboardInput,
        );

        input.cursorPosition.value += clipboardInput.length;
        return;
      }

      if (ctrl || meta || shift) return;

      switch (key) {
        case "escape":
          box.destroy();
          textBox.destroy();
          reject("Canceled");
          break;
        case "return":
          box.destroy();
          textBox.destroy();
          resolve(input.text.peek());
          break;
      }
    });
  });
};
