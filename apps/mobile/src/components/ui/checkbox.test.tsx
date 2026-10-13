import { fireEvent, render, screen } from "@testing-library/react-native";
import { Checkbox } from "./checkbox";

describe("Checkbox", () => {
  it("toggles when pressed", async () => {
    const onCheckedChange = jest.fn();
    await render(
      <Checkbox accessibilityLabel="Done" checked={false} onCheckedChange={onCheckedChange} />,
    );
    await fireEvent.press(screen.getByRole("checkbox", { name: "Done" }));
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it("stays as it is while disabled", async () => {
    const onCheckedChange = jest.fn();
    await render(
      <Checkbox accessibilityLabel="Done" checked onCheckedChange={onCheckedChange} disabled />,
    );
    const checkbox = screen.getByRole("checkbox", { name: "Done" });
    expect(checkbox).toBeChecked();
    expect(checkbox).toBeDisabled();
    await fireEvent.press(checkbox);
    expect(onCheckedChange).not.toHaveBeenCalled();
  });
});
