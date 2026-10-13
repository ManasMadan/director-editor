"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { type OrgRole, orgRoleSchema, parseOrgRole } from "@repo/contracts/roles";
import { Badge } from "@repo/ui/components/badge";
import { Button } from "@repo/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/ui/components/card";
import { Field, FieldGroup, FieldLabel } from "@repo/ui/components/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/ui/components/select";
import { Skeleton } from "@repo/ui/components/skeleton";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";
import * as z from "zod";
import { TextField } from "@/components/form-fields";
import { authClient } from "@/lib/auth-client";
import { useAuthErrorMessage, useAuthSchemas } from "@/modules/auth";
import { UpgradeHint } from "@/modules/billing";
import {
  isPersonal,
  useActiveWorkspace,
  useRefreshWorkspaces,
  useSwitchWorkspace,
  useWorkspaces,
} from "../hooks/use-workspace";

const ROLES: OrgRole[] = ["member", "admin", "owner"];

function RoleSelect({
  value,
  onChange,
  label,
  id,
}: {
  /** Null when the stored role isn't one the app knows: nothing is selected. */
  value: OrgRole | null;
  onChange: (role: OrgRole) => void;
  label: string;
  id: string;
}) {
  const t = useTranslations("workspace.members.role");
  return (
    <Select
      value={value}
      // Only the ROLES items can be picked.
      onValueChange={(next) => onChange(orgRoleSchema.parse(next))}
      items={ROLES.map((role) => ({ value: role, label: t(role) }))}
    >
      <SelectTrigger id={id} aria-label={label} className="w-36">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {ROLES.map((role) => (
          <SelectItem key={role} value={role}>
            {t(role)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

type Member = NonNullable<ReturnType<typeof useActiveWorkspace>["data"]>["members"][number];

/** A member: name and address, and for an admin looking at someone else, role and removal. */
function MemberRow({
  member,
  organizationId,
  isYou,
  canManage,
  run,
}: {
  member: Member;
  organizationId: string;
  isYou: boolean;
  canManage: boolean;
  run: (call: Promise<{ error: unknown }>, success: string) => Promise<void>;
}) {
  const t = useTranslations("workspace.members");
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 py-3">
      <div className="flex flex-col">
        <span className="flex items-center gap-2 text-sm font-medium">
          {member.user.name}
          {isYou ? <Badge variant="secondary">{t("you")}</Badge> : null}
        </span>
        <span className="text-xs text-muted-foreground">{member.user.email}</span>
      </div>
      <div className="flex items-center gap-2">
        {canManage ? (
          <>
            <RoleSelect
              id={`role-${member.id}`}
              label={t("roleLabel", { name: member.user.name })}
              value={parseOrgRole(member.role)}
              onChange={(role) =>
                run(
                  authClient.organization.updateMemberRole({
                    memberId: member.id,
                    role,
                    organizationId,
                  }),
                  t("roleChanged"),
                )
              }
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                run(
                  authClient.organization.removeMember({
                    memberIdOrEmail: member.id,
                    organizationId,
                  }),
                  t("removed"),
                )
              }
            >
              {t("remove")}
            </Button>
          </>
        ) : (
          <Badge variant="outline">{t(`role.${parseOrgRole(member.role) ?? "unknown"}`)}</Badge>
        )}
      </div>
    </li>
  );
}

export function WorkspaceMembersPage() {
  const t = useTranslations("workspace.members");
  const errorMessage = useAuthErrorMessage();
  const active = useActiveWorkspace();
  const refresh = useRefreshWorkspaces();
  const workspaces = useWorkspaces();
  const switchTo = useSwitchWorkspace();
  const router = useRouter();
  if (!active.data) {
    return <Skeleton className="h-40" />;
  }
  const workspace = active.data;
  const owners = workspace.members.filter((member) => parseOrgRole(member.role) === "owner").length;

  async function run(call: Promise<{ error: unknown }>, success: string) {
    const { error } = await call;
    if (error) {
      return void toast.error(errorMessage(error));
    }
    await refresh();
    toast.success(success);
  }

  async function leave() {
    // Move to another workspace first, so no request ever runs in one you've left.
    const next = (await workspaces.refetch()).data?.find((other) => other.id !== workspace.id);
    if (next) {
      await switchTo(next.id);
    }
    const { error } = await authClient.organization.leave({ organizationId: workspace.id });
    if (error) {
      return void toast.error(errorMessage(error));
    }
    toast.success(t("left"));
    router.replace("/dashboard");
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>{t("title")}</CardTitle>
          <CardDescription>{t("description", { name: workspace.name })}</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="flex flex-col divide-y">
            {workspace.members.map((member) => (
              <MemberRow
                key={member.id}
                member={member}
                organizationId={workspace.id}
                isYou={member.userId === active.userId}
                canManage={active.isAdmin && member.userId !== active.userId}
                run={run}
              />
            ))}
          </ul>
          {!isPersonal(workspace) && (active.role !== "owner" || owners > 1) ? (
            <Button variant="outline" className="mt-4" onClick={leave}>
              {t("leave")}
            </Button>
          ) : null}
        </CardContent>
      </Card>
      {active.isAdmin && !isPersonal(workspace) ? (
        <>
          <UpgradeHint entitlement="members" />
          <InviteCard organizationId={workspace.id} />
        </>
      ) : null}
      {active.isAdmin && !isPersonal(workspace) ? (
        <PendingInvitations
          invitations={workspace.invitations.filter(
            (invitation) => invitation.status === "pending",
          )}
        />
      ) : null}
    </>
  );
}

function InviteCard({ organizationId }: { organizationId: string }) {
  const t = useTranslations("workspace.members.invite");
  const errorMessage = useAuthErrorMessage();
  const refresh = useRefreshWorkspaces();
  const schema = z.object({
    email: useAuthSchemas().email,
    role: z.enum(["member", "admin", "owner"]),
  });
  const form = useForm({
    resolver: zodResolver(schema),
    defaultValues: { email: "", role: "member" as OrgRole },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          noValidate
          onSubmit={form.handleSubmit(async ({ email, role }) => {
            const { error } = await authClient.organization.inviteMember({
              email,
              role,
              organizationId,
            });
            if (error) {
              return void toast.error(errorMessage(error));
            }
            await refresh();
            toast.success(t("sent", { email }));
            form.reset({ email: "", role });
          })}
        >
          <FieldGroup>
            <TextField
              control={form.control}
              name="email"
              label={t("email")}
              type="email"
              autoComplete="off"
            />
            <Controller
              control={form.control}
              name="role"
              render={({ field }) => (
                <Field>
                  <FieldLabel htmlFor="invite-role">{t("role")}</FieldLabel>
                  <RoleSelect
                    id="invite-role"
                    label={t("role")}
                    value={field.value}
                    onChange={field.onChange}
                  />
                </Field>
              )}
            />
            <Button type="submit" className="self-start" disabled={form.formState.isSubmitting}>
              {t("submit")}
            </Button>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
}

function PendingInvitations({
  invitations,
}: {
  invitations: { id: string; email: string; role: string; expiresAt: Date }[];
}) {
  const t = useTranslations("workspace.members");
  const format = useFormatter();
  const errorMessage = useAuthErrorMessage();
  const refresh = useRefreshWorkspaces();

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("pending.title")}</CardTitle>
      </CardHeader>
      <CardContent>
        {invitations.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("pending.empty")}</p>
        ) : (
          <ul className="flex flex-col divide-y">
            {invitations.map((invitation) => (
              <li
                key={invitation.id}
                className="flex items-center justify-between gap-3 py-2 text-sm"
              >
                <div className="flex flex-col">
                  <span>{invitation.email}</span>
                  <span className="text-xs text-muted-foreground">
                    {t("pending.invited", {
                      role: t(`role.${parseOrgRole(invitation.role) ?? "unknown"}`),
                    })}{" "}
                    · {format.dateTime(new Date(invitation.expiresAt), { dateStyle: "medium" })}
                  </span>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={async () => {
                    const { error } = await authClient.organization.cancelInvitation({
                      invitationId: invitation.id,
                    });
                    if (error) {
                      return void toast.error(errorMessage(error));
                    }
                    await refresh();
                    toast.success(t("pending.cancelled"));
                  }}
                >
                  {t("pending.cancel")}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
