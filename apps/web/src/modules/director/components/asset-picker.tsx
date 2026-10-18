"use client";

import { useApiErrorMessage } from "@repo/client";
import { useAddStockAssetMutation } from "@repo/client/api/assets/add-stock";
import { useChooseAssetMutation } from "@repo/client/api/assets/choose";
import { useDrawAssetMutation } from "@repo/client/api/assets/draw";
import { useAssetSlotsQuery } from "@repo/client/api/assets/slots";
import { useStockSearchQuery } from "@repo/client/api/assets/stock-search";
import { useUploadAssetMutation } from "@repo/client/api/assets/upload";
import { checkUpload } from "@repo/client/api/files/upload";
import { useSystemInfoQuery } from "@repo/client/api/system/info";
import {
  ASSET_INSTRUCTION_MAX_LENGTH,
  ASSET_PROMPT_MAX_LENGTH,
  type AssetImage,
  type AssetSlot,
  type ServedShotPlan,
  type StockPhoto,
} from "@repo/contracts/api";
import { Button } from "@repo/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@repo/ui/components/dialog";
import { Field, FieldDescription, FieldLabel } from "@repo/ui/components/field";
import { GeminiLoader } from "@repo/ui/components/gemini-loader";
import { Input } from "@repo/ui/components/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@repo/ui/components/tabs";
import { Textarea } from "@repo/ui/components/textarea";
import { cn } from "@repo/ui/lib/utils";
import { Check, CircleAlert, ImagePlus, Plus, Send, Undo2, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { type FormEvent, useId, useState } from "react";
import { isGapSlot } from "../lib/scene";
import { slotOrientation, slotPlacement } from "../lib/slot-preview";
import { SlotPreview } from "./slot-preview";

type Asset = ServedShotPlan["assets"][number];
type Source = "upload" | "create" | "stock";
/** What's selected in the slot: one of the member's images, or the default. */
type Selected = string | "default";

const PICTURE = "director-asset-image";

/**
 * Which tab opens first: Upload for a slot about the member's own thing (the plan asks
 * for a photo of theirs), Stock for footage-like pictures when stock is on, Create with
 * AI otherwise (a personalisable graphic, or anything Director drew).
 */
function firstSource(asset: Asset, stock: boolean): Source {
  if (asset.ask) {
    return "upload";
  }
  return asset.defaultSource === "stock" && stock ? "stock" : "create";
}

/** The camera's frame for the preview: the template's storyboard of that moment. */
function cameraFrame(plan: ServedShotPlan, asset: Asset) {
  const shot = plan.shots.find(
    (candidate) =>
      candidate.sourceStartSeconds <= asset.sourceStartSeconds &&
      candidate.sourceEndSeconds > asset.sourceStartSeconds,
  );
  return shot?.storyboardUrl;
}

function urlOf(slot: AssetSlot, selected: Selected) {
  if (selected === "default") {
    return slot.defaultImage?.url ?? null;
  }
  return slot.images.find((image) => image.id === selected)?.url ?? null;
}

function Tile({
  label,
  image,
  selected,
  inUse,
  onSelect,
}: {
  label: string;
  image: Pick<AssetImage, "status" | "url"> & { media?: AssetImage["media"] };
  selected: boolean;
  inUse: boolean;
  onSelect: () => void;
}) {
  const t = useTranslations("director.picker");
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={inUse ? t("tileInUse", { label }) : label}
      disabled={image.status !== "ready"}
      onClick={onSelect}
      className={cn(
        "relative flex aspect-square min-h-11 items-center justify-center overflow-hidden rounded-lg bg-muted ring-offset-2 ring-offset-background",
        selected && "ring-2 ring-primary",
      )}
    >
      {image.status === "ready" && image.url && image.media === "video" ? (
        <video src={image.url} muted loop autoPlay playsInline className="size-full object-cover" />
      ) : null}
      {image.status === "ready" && image.url && image.media !== "video" ? (
        <img src={image.url} alt="" className="size-full object-cover" />
      ) : null}
      {image.status === "making" ? <GeminiLoader label={t("making")} size="sm" showLabel /> : null}
      {image.status === "failed" ? (
        <span className="flex flex-col items-center gap-1 p-1 text-center text-xs text-destructive">
          <CircleAlert className="size-4" aria-hidden />
          {t("failed")}
        </span>
      ) : null}
      {inUse ? (
        <span className="absolute top-1 right-1 rounded-full bg-primary p-0.5 text-primary-foreground">
          <Check className="size-3" aria-hidden />
        </span>
      ) : null}
    </button>
  );
}

function Results({
  slot,
  origins,
  selected,
  onSelect,
  extra,
}: {
  slot: AssetSlot;
  origins: readonly AssetImage["origin"][];
  selected: Selected;
  onSelect: (selected: Selected) => void;
  extra?: React.ReactNode;
}) {
  const t = useTranslations("director.picker");
  const images = slot.images.filter((image) => origins.includes(image.origin));
  const showDefault = origins.includes("created") && slot.defaultImage;
  return (
    <section aria-label={t("results")} className="grid grid-cols-3 gap-2">
      {showDefault && slot.defaultImage ? (
        <Tile
          label={t("defaultImage")}
          image={slot.defaultImage}
          selected={selected === "default"}
          inUse={slot.chosenId === null}
          onSelect={() => onSelect("default")}
        />
      ) : null}
      {images.map((image, index) => (
        <Tile
          key={image.id}
          label={
            image.credit ? t("stockBy", creditParams(image)) : t("yours", { index: index + 1 })
          }
          image={image}
          selected={selected === image.id}
          inUse={slot.chosenId === image.id}
          onSelect={() => onSelect(image.id)}
        />
      ))}
      {extra}
      {images.length === 0 && !showDefault && !extra ? (
        <p className="col-span-3 text-sm text-muted-foreground">{t("empty")}</p>
      ) : null}
    </section>
  );
}

const PROVIDERS = { pexels: "Pexels", pixabay: "Pixabay" } as const;

function creditParams(image: Pick<AssetImage, "credit">) {
  return {
    author: image.credit?.author ?? "",
    provider: image.credit ? PROVIDERS[image.credit.provider] : "",
  };
}

/** "Add your photo as reference": a photo of the member's to draw from, checked first. */
function ReferencePicker({
  reference,
  onChange,
}: {
  reference: File | null;
  onChange: (file: File | null) => void;
}) {
  const t = useTranslations("director.picker");
  const [refused, setRefused] = useState<string | null>(null);
  const inputId = useId();
  const pick = (file: File | undefined) => {
    const problem = file ? checkUpload(PICTURE, file) : null;
    setRefused(problem ? t(`refused.${problem.code}`) : null);
    onChange(file && !problem ? file : null);
  };
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <label
          htmlFor={inputId}
          className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-md px-2 text-sm font-medium text-primary underline-offset-4 hover:underline"
        >
          <ImagePlus className="size-4" aria-hidden />
          {reference ? t("referenceAdded", { name: reference.name }) : t("addReference")}
        </label>
        <input
          id={inputId}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="sr-only"
          onChange={(event) => pick(event.target.files?.[0])}
        />
        {reference ? (
          <Button type="button" variant="ghost" size="sm" onClick={() => onChange(null)}>
            <X aria-hidden />
            {t("removeReference")}
          </Button>
        ) : null}
      </div>
      {refused ? <p className="text-sm text-destructive">{refused}</p> : null}
    </>
  );
}

/** Edit by prompt: "make it moodier" on the picture selected. */
function EditForm({
  busy,
  onEdit,
}: {
  busy: boolean;
  onEdit: (instruction: string, done: () => void) => void;
}) {
  const t = useTranslations("director.picker");
  const [instruction, setInstruction] = useState("");
  const inputId = useId();
  return (
    <form
      className="flex items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (instruction.trim()) {
          onEdit(instruction.trim(), () => setInstruction(""));
        }
      }}
    >
      <Field className="flex-1">
        <FieldLabel htmlFor={inputId}>{t("editLabel")}</FieldLabel>
        <Input
          id={inputId}
          value={instruction}
          maxLength={ASSET_INSTRUCTION_MAX_LENGTH}
          placeholder={t("editPlaceholder")}
          onChange={(event) => setInstruction(event.target.value)}
        />
      </Field>
      <Button
        type="submit"
        size="icon"
        className="size-11"
        aria-label={t("edit")}
        disabled={busy || !instruction.trim()}
      >
        <Send aria-hidden />
      </Button>
    </form>
  );
}

function CreateTab({
  videoId,
  slot,
  selected,
  onSelect,
  left,
  gap,
}: {
  videoId: string;
  slot: AssetSlot;
  selected: Selected;
  onSelect: (selected: Selected) => void;
  left: number;
  /** A gap's slot: it can also be a Veo clip. */
  gap: boolean;
}) {
  const t = useTranslations("director.picker");
  const errorMessage = useApiErrorMessage();
  const draw = useDrawAssetMutation();
  const [prompt, setPrompt] = useState(slot.prompt);
  const [reference, setReference] = useState<File | null>(null);
  const promptId = useId();
  const baseId = selected === "default" ? slot.defaultImage?.id : selected;
  const busy = draw.isPending || left <= 0;
  const create = (event?: FormEvent, clip = false) => {
    event?.preventDefault();
    draw.mutate({
      videoId,
      assetId: slot.assetId,
      prompt: prompt.trim() || slot.prompt,
      ...(reference && !clip && { reference }),
      ...(clip && { clip }),
    });
  };
  const another =
    slot.images.some((image) => image.origin === "created") || slot.defaultImage ? (
      <button
        type="button"
        onClick={() => create()}
        disabled={busy}
        className="flex aspect-square min-h-11 flex-col items-center justify-center gap-1 rounded-lg border border-dashed text-xs text-muted-foreground disabled:opacity-50"
      >
        <Plus className="size-5" aria-hidden />
        {t("another")}
      </button>
    ) : null;
  return (
    <div className="flex flex-col gap-4">
      <form onSubmit={create} className="flex flex-col gap-2">
        <Field>
          <FieldLabel htmlFor={promptId}>{t("promptLabel")}</FieldLabel>
          <Textarea
            id={promptId}
            value={prompt}
            maxLength={ASSET_PROMPT_MAX_LENGTH}
            rows={5}
            onChange={(event) => setPrompt(event.target.value)}
          />
          <FieldDescription>{t("promptHint")}</FieldDescription>
        </Field>
        <ReferencePicker reference={reference} onChange={setReference} />
        <Button type="submit" disabled={busy} className="min-h-11">
          {draw.isPending ? t("sending") : t("create")}
        </Button>
        {gap ? (
          <>
            <Button
              type="button"
              variant="secondary"
              disabled={busy}
              onClick={() => create(undefined, true)}
              className="min-h-11"
            >
              {t("clip")}
            </Button>
            <p className="text-xs text-muted-foreground">{t("clipHint")}</p>
          </>
        ) : null}
        <p className="text-xs text-muted-foreground">{t("left", { left: Math.max(left, 0) })}</p>
      </form>
      <Results
        slot={slot}
        origins={["created"]}
        selected={selected}
        onSelect={onSelect}
        extra={another}
      />
      {baseId ? (
        <EditForm
          busy={busy}
          onEdit={(instruction, done) =>
            draw.mutate(
              { videoId, assetId: slot.assetId, prompt, instruction, baseId },
              { onSuccess: done },
            )
          }
        />
      ) : null}
      {draw.error ? (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(draw.error)}
        </p>
      ) : null}
    </div>
  );
}

function UploadTab({
  videoId,
  slot,
  ask,
  selected,
  onSelect,
}: {
  videoId: string;
  slot: AssetSlot;
  ask: string | null;
  selected: Selected;
  onSelect: (selected: Selected) => void;
}) {
  const t = useTranslations("director.picker");
  const errorMessage = useApiErrorMessage();
  const upload = useUploadAssetMutation();
  const [refused, setRefused] = useState<string | null>(null);
  const inputId = useId();
  const send = (file: File | undefined) => {
    if (!file) {
      return;
    }
    const problem = checkUpload(PICTURE, file);
    setRefused(problem ? t(`refused.${problem.code}`) : null);
    if (!problem) {
      upload.mutate(
        { videoId, assetId: slot.assetId, file },
        { onSuccess: (image) => onSelect(image.id) },
      );
    }
  };
  return (
    <div className="flex flex-col gap-3">
      {ask ? <p className="text-sm">{ask}</p> : null}
      <label
        htmlFor={inputId}
        className="flex min-h-24 cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed p-4 text-sm font-medium"
      >
        {upload.isPending ? (
          <GeminiLoader label={t("uploading")} size="sm" showLabel />
        ) : (
          <>
            <ImagePlus className="size-6" aria-hidden />
            {t("chooseFile")}
          </>
        )}
      </label>
      <input
        id={inputId}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="sr-only"
        disabled={upload.isPending}
        onChange={(event) => send(event.target.files?.[0])}
      />
      <p className="text-xs text-muted-foreground">{t("uploadHint")}</p>
      {refused ? <p className="text-sm text-destructive">{refused}</p> : null}
      {upload.error ? (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(upload.error)}
        </p>
      ) : null}
      <Results slot={slot} origins={["upload"]} selected={selected} onSelect={onSelect} />
    </div>
  );
}

function StockResult({
  photo,
  busy,
  onPick,
}: {
  photo: StockPhoto;
  busy: boolean;
  onPick: () => void;
}) {
  const t = useTranslations("director.picker");
  const credit = t("stockBy", { author: photo.author, provider: PROVIDERS[photo.provider] });
  return (
    <li className="flex flex-col gap-1">
      <button
        type="button"
        onClick={onPick}
        disabled={busy}
        aria-label={t("useStock", { credit })}
        className="aspect-square min-h-11 overflow-hidden rounded-lg bg-muted"
      >
        <img src={photo.previewUrl} alt={photo.alt} className="size-full object-cover" />
      </button>
      <a
        href={photo.pageUrl}
        target="_blank"
        rel="noreferrer"
        className="truncate text-[0.7rem] text-muted-foreground underline-offset-2 hover:underline"
      >
        {credit}
      </a>
    </li>
  );
}

function StockTab({
  videoId,
  asset,
  plan,
  slot,
  selected,
  onSelect,
}: {
  videoId: string;
  asset: Asset;
  plan: ServedShotPlan;
  slot: AssetSlot;
  selected: Selected;
  onSelect: (selected: Selected) => void;
}) {
  const t = useTranslations("director.picker");
  const errorMessage = useApiErrorMessage();
  const [query, setQuery] = useState(asset.reference.subject.slice(0, 100));
  const [searched, setSearched] = useState(query);
  const orientation = slotOrientation(slotPlacement(plan, asset).asset);
  const results = useStockSearchQuery(searched, orientation);
  const add = useAddStockAssetMutation();
  const inputId = useId();
  return (
    <div className="flex flex-col gap-3">
      <form
        className="flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setSearched(query);
        }}
      >
        <Field className="flex-1">
          <FieldLabel htmlFor={inputId}>{t("stockLabel")}</FieldLabel>
          <Input
            id={inputId}
            value={query}
            maxLength={100}
            onChange={(event) => setQuery(event.target.value)}
          />
        </Field>
        <Button type="submit" className="min-h-11">
          {t("search")}
        </Button>
      </form>
      <p className="text-xs text-muted-foreground">{t("stockFrom")}</p>
      {results.isFetching && !results.data ? (
        <GeminiLoader label={t("searching")} size="sm" showLabel />
      ) : null}
      {results.error ? (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(results.error)}
        </p>
      ) : null}
      {results.data?.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("stockEmpty")}</p>
      ) : null}
      {results.data?.length ? (
        <ul className="grid grid-cols-3 gap-2">
          {results.data.map((photo) => (
            <StockResult
              key={`${photo.provider}-${photo.id}`}
              photo={photo}
              busy={add.isPending}
              onPick={() =>
                add.mutate(
                  { videoId, assetId: slot.assetId, provider: photo.provider, photoId: photo.id },
                  { onSuccess: (image) => onSelect(image.id) },
                )
              }
            />
          ))}
        </ul>
      ) : null}
      {add.isPending ? <GeminiLoader label={t("copying")} size="sm" showLabel /> : null}
      {add.error ? (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(add.error)}
        </p>
      ) : null}
      <Results slot={slot} origins={["stock"]} selected={selected} onSelect={onSelect} />
    </div>
  );
}

function Footer({
  videoId,
  plan,
  asset,
  slot,
  selected,
}: {
  videoId: string;
  plan: ServedShotPlan;
  asset: Asset;
  slot: AssetSlot;
  selected: Selected;
}) {
  const t = useTranslations("director.picker");
  const errorMessage = useApiErrorMessage();
  const choose = useChooseAssetMutation();
  const [previewing, setPreviewing] = useState(false);
  const imageId = selected === "default" ? null : selected;
  const inUse = slot.chosenId === imageId;
  const previous = slot.history[0];
  const url = urlOf(slot, selected);
  return (
    <div className="flex flex-col gap-3 border-t pt-3">
      <Button
        type="button"
        variant="outline"
        className="min-h-11"
        aria-expanded={previewing}
        onClick={() => setPreviewing((open) => !open)}
      >
        {previewing ? t("previewHide") : t("preview")}
      </Button>
      {previewing ? (
        <SlotPreview
          placement={slotPlacement(plan, asset)}
          imageUrl={url}
          cameraUrl={cameraFrame(plan, asset)}
        />
      ) : null}
      <div className="flex gap-2">
        {previous !== undefined ? (
          <Button
            type="button"
            variant="ghost"
            className="min-h-11"
            disabled={choose.isPending}
            onClick={() => choose.mutate({ videoId, assetId: slot.assetId, imageId: previous })}
          >
            <Undo2 aria-hidden />
            {t("undo")}
          </Button>
        ) : null}
        <Button
          type="button"
          className="min-h-11 flex-1"
          disabled={inUse || !url || choose.isPending}
          onClick={() => choose.mutate({ videoId, assetId: slot.assetId, imageId })}
        >
          {inUse ? t("using") : t("use")}
        </Button>
      </div>
      <p aria-live="polite" className="sr-only">
        {choose.isSuccess ? t("placed") : ""}
      </p>
      {choose.error ? (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(choose.error)}
        </p>
      ) : null}
    </div>
  );
}

function PickerBody({
  videoId,
  plan,
  asset,
}: {
  videoId: string;
  plan: ServedShotPlan;
  asset: Asset;
}) {
  const t = useTranslations("director.picker");
  const errorMessage = useApiErrorMessage();
  const slots = useAssetSlotsQuery(videoId);
  const stock = useSystemInfoQuery().data?.features.stock === true;
  const [tab, setTab] = useState<Source>(() => firstSource(asset, stock));
  const slot = slots.data?.slots.find((candidate) => candidate.assetId === asset.id);
  const [selected, setSelected] = useState<Selected | null>(null);
  if (slots.error) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {errorMessage(slots.error)}
      </p>
    );
  }
  if (!slot || !slots.data) {
    return <GeminiLoader label={t("loading")} showLabel />;
  }
  const current: Selected = selected ?? slot.chosenId ?? "default";
  const images = slots.data.images;
  const left = Math.min(images.perVideo - images.used, images.perDay - images.today);
  const props = { videoId, slot, selected: current, onSelect: setSelected };
  return (
    <>
      <Tabs value={tab} onValueChange={(value: Source) => setTab(value)}>
        <TabsList className="w-full">
          <TabsTrigger value="upload" className="min-h-11">
            {t("tabs.upload")}
          </TabsTrigger>
          <TabsTrigger value="create" className="min-h-11">
            {t("tabs.create")}
          </TabsTrigger>
          {stock ? (
            <TabsTrigger value="stock" className="min-h-11">
              {t("tabs.stock")}
            </TabsTrigger>
          ) : null}
        </TabsList>
        <TabsContent value="upload" className="pt-3">
          <UploadTab {...props} ask={asset.ask} />
        </TabsContent>
        <TabsContent value="create" className="pt-3">
          <CreateTab {...props} left={left} gap={isGapSlot(asset.id)} />
        </TabsContent>
        {stock ? (
          <TabsContent value="stock" className="pt-3">
            <StockTab {...props} asset={asset} plan={plan} />
          </TabsContent>
        ) : null}
      </Tabs>
      <Footer videoId={videoId} plan={plan} asset={asset} slot={slot} selected={current} />
    </>
  );
}

/**
 * The asset picker: one sheet for one of the template's asset slots, with three sources
 * (Upload, Create with AI, Stock when it's on), the suggested one open first, a preview
 * of the selected picture in the member's video, and "Use this", which the slot keeps
 * with its history (undo).
 */
export function AssetPicker({
  videoId,
  plan,
  asset,
  open,
  onOpenChange,
}: {
  videoId: string;
  plan: ServedShotPlan;
  asset: Asset;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] gap-4 overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-lg font-semibold">{asset.title}</DialogTitle>
          <DialogDescription>{asset.role}</DialogDescription>
        </DialogHeader>
        {open ? <PickerBody videoId={videoId} plan={plan} asset={asset} /> : null}
      </DialogContent>
    </Dialog>
  );
}
