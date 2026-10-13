import { fireEvent, render, screen } from "@testing-library/react-native";
import { Label } from "./label";

describe("Label", () => {
  it("answers a press", async () => {
    const onPress = jest.fn();
    await render(<Label onPress={onPress}>Email</Label>);
    await fireEvent.press(screen.getByText("Email"));
    expect(onPress).toHaveBeenCalled();
  });

  it("ignores presses while disabled", async () => {
    const onPress = jest.fn();
    await render(
      <Label onPress={onPress} disabled>
        Email
      </Label>,
    );
    await fireEvent.press(screen.getByText("Email"));
    expect(onPress).not.toHaveBeenCalled();
  });
});
