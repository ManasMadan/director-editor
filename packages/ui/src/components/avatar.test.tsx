import { describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "../../test/render";
import { Avatar, AvatarBadge, AvatarFallback, AvatarGroup, AvatarGroupCount } from "./avatar";

describe("Avatar", () => {
  it("shows a status badge, and a group says how many more there are", async () => {
    render(
      <AvatarGroup>
        <Avatar>
          <AvatarFallback>AL</AvatarFallback>
          <AvatarBadge aria-label="Online" />
        </Avatar>
        <Avatar>
          <AvatarFallback>GH</AvatarFallback>
        </Avatar>
        <AvatarGroupCount>+3</AvatarGroupCount>
      </AvatarGroup>,
    );
    await expect.element(page.getByLabelText("Online")).toBeVisible();
    await expect.element(page.getByText("+3")).toBeVisible();
  });
});
