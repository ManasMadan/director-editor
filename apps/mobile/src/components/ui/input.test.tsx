import { render, screen } from "@testing-library/react-native";
import { Input } from "./input";

describe("Input", () => {
  it("can be read-only", async () => {
    await render(<Input accessibilityLabel="Email" value="ada@example.com" editable={false} />);
    expect(screen.getByLabelText("Email")).toBeDisabled();
    expect(screen.getByLabelText("Email")).toHaveDisplayValue("ada@example.com");
  });
});
