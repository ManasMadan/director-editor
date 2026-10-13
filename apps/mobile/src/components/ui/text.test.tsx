import { render, screen } from "@testing-library/react-native";
import { Text as NativeText } from "react-native";
import { Text } from "./text";

describe("Text", () => {
  it("gives headings their role", async () => {
    await render(<Text variant="h2">Billing</Text>);
    expect(screen.getByRole("heading", { name: "Billing" })).toBeOnTheScreen();
  });

  it("can pass its role and styles to its child instead", async () => {
    await render(
      <Text variant="h1" asChild>
        <NativeText>Welcome</NativeText>
      </Text>,
    );
    expect(screen.getByRole("heading", { name: "Welcome" })).toBeOnTheScreen();
  });

  it("is plain text without a variant", async () => {
    await render(<Text variant={null}>Plain</Text>);
    expect(screen.getByText("Plain")).toBeOnTheScreen();
    expect(screen.queryByRole("heading")).not.toBeOnTheScreen();
  });
});
