import { copyTextToSystemClipboard } from "@excalidraw/excalidraw/clipboard";
import { FilledButton } from "@excalidraw/excalidraw/components/FilledButton";
import { RadioGroup } from "@excalidraw/excalidraw/components/RadioGroup";
import { TextField } from "@excalidraw/excalidraw/components/TextField";
import {
  LinkIcon,
  TrashIcon,
  copyIcon,
} from "@excalidraw/excalidraw/components/icons";
import { useUIAppState } from "@excalidraw/excalidraw/context/ui-appState";
import { KEYS } from "@excalidraw/common";
import { useCallback, useEffect, useState } from "react";

import { atom, useAtomValue } from "../app-jotai";
import {
  createShareLink,
  getCurrentCanvasId,
  listShareLinks,
  revokeShareLink,
} from "../data/CanvasStore";

import type { CollabAPI } from "../collab/Collab";
import type { ShareLink, ShareMode, SharedCanvas } from "../data/CanvasStore";

/** the canvas this tab's share link opened (set once it loaded) */
export const sharedCanvasAtom = atom<SharedCanvas | null>(null);

const MODE_LABEL: Record<ShareMode, string> = {
  view: "Can view",
  edit: "Can edit",
};

const formatDate = (timestamp: number) =>
  new Date(timestamp).toLocaleDateString(undefined, { dateStyle: "medium" });

const UsernameField = ({
  collabAPI,
  handleClose,
}: {
  collabAPI: CollabAPI;
  handleClose: () => void;
}) => (
  <TextField
    defaultValue={collabAPI.getUsername()}
    placeholder="Your name"
    label="Your name (shown to others on this canvas)"
    onChange={collabAPI.setUsername}
    onKeyDown={(event) => event.key === KEYS.ENTER && handleClose()}
  />
);

const ShareLinkRow = ({
  link,
  onRevoke,
}: {
  link: ShareLink;
  onRevoke: (link: ShareLink) => void;
}) => {
  const [isCopied, setIsCopied] = useState(false);

  useEffect(() => {
    if (isCopied) {
      const timer = window.setTimeout(() => setIsCopied(false), 2000);
      return () => window.clearTimeout(timer);
    }
  }, [isCopied]);

  return (
    <li className="CanvasShare__link">
      <div className="CanvasShare__link__meta">
        <span className={`CanvasShare__badge CanvasShare__badge--${link.mode}`}>
          {MODE_LABEL[link.mode]}
        </span>
        <span>created {formatDate(link.createdAt)}</span>
      </div>
      <div className="CanvasShare__link__row">
        <TextField readonly fullWidth value={link.url} />
        <FilledButton
          size="large"
          label={isCopied ? "Copied" : "Copy"}
          icon={copyIcon}
          status={isCopied ? "success" : null}
          onClick={async () => {
            await copyTextToSystemClipboard(link.url);
            setIsCopied(true);
          }}
        />
        <FilledButton
          size="large"
          variant="icon"
          color="danger"
          label="Turn off link"
          icon={TrashIcon}
          onClick={() => onRevoke(link)}
        />
      </div>
    </li>
  );
};

const OwnerShareDialog = ({
  collabAPI,
  handleClose,
}: {
  collabAPI: CollabAPI;
  handleClose: () => void;
}) => {
  const { name } = useUIAppState();
  const canvasId = getCurrentCanvasId();
  const [links, setLinks] = useState<ShareLink[] | null>(null);
  const [mode, setMode] = useState<ShareMode>("view");
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async (action: () => Promise<void>) => {
    setIsBusy(true);
    setError(null);
    try {
      await action();
    } catch (error: any) {
      setError(error.message);
    } finally {
      setIsBusy(false);
    }
  }, []);

  useEffect(() => {
    if (canvasId) {
      run(async () => setLinks(await listShareLinks(canvasId)));
    }
  }, [canvasId, run]);

  if (!canvasId) {
    return (
      <div className="CanvasShare__description">
        Your canvases couldn't be loaded, so this canvas can't be shared yet.
      </div>
    );
  }

  return (
    <>
      <h3 className="ShareDialog__active__header">
        Share {name ? `“${name}”` : "this canvas"}
      </h3>
      <div className="CanvasShare__description">
        This canvas is live: everyone who has it open sees changes as they
        happen. A share link opens this canvas only, without signing in, and
        none of your other canvases.
      </div>

      <UsernameField collabAPI={collabAPI} handleClose={handleClose} />

      <div className="CanvasShare__create">
        <RadioGroup<ShareMode>
          name="canvas-share-mode"
          value={mode}
          onChange={setMode}
          choices={[
            { value: "view", label: MODE_LABEL.view },
            { value: "edit", label: MODE_LABEL.edit },
          ]}
        />
        <FilledButton
          size="large"
          label="Create link"
          icon={LinkIcon}
          disabled={isBusy}
          onClick={() =>
            run(async () => {
              const link = await createShareLink(canvasId, mode);
              setLinks((links) => [link, ...(links || [])]);
              await copyTextToSystemClipboard(link.url).catch(() => {});
            })
          }
        />
      </div>

      {error && <div className="CanvasShare__error">{error}</div>}

      {links === null ? (
        !error && <div className="CanvasShare__description">Loading links…</div>
      ) : links.length ? (
        <ul className="CanvasShare__links">
          {links.map((link) => (
            <ShareLinkRow
              key={link.token}
              link={link}
              onRevoke={(link) => {
                if (
                  window.confirm(
                    "Turn off this link? Anyone using it is disconnected and can't open the canvas again.",
                  )
                ) {
                  run(async () => {
                    await revokeShareLink(link.token);
                    setLinks(
                      (links) =>
                        links?.filter((other) => other.token !== link.token) ||
                        null,
                    );
                  });
                }
              }}
            />
          ))}
        </ul>
      ) : (
        <div className="CanvasShare__description">
          No links yet. New links are copied to your clipboard.
        </div>
      )}
    </>
  );
};

const GuestShareDialog = ({
  collabAPI,
  handleClose,
}: {
  collabAPI: CollabAPI;
  handleClose: () => void;
}) => {
  const sharedCanvas = useAtomValue(sharedCanvasAtom);

  return (
    <>
      <h3 className="ShareDialog__active__header">
        {sharedCanvas?.name || "Shared canvas"}
      </h3>
      <div className="CanvasShare__description">
        {sharedCanvas?.mode === "edit"
          ? "Someone shared this canvas with you to edit. Your changes are saved, and everyone on the canvas sees them live."
          : "Someone shared this canvas with you to view. Changes others make show up live."}
      </div>
      <UsernameField collabAPI={collabAPI} handleClose={handleClose} />
    </>
  );
};

/** the share dialog with multiple canvases (see data/CanvasStore.ts) */
export const CanvasShareDialog = ({
  collabAPI,
  isGuest,
  handleClose,
}: {
  collabAPI: CollabAPI | null;
  isGuest: boolean;
  handleClose: () => void;
}) => {
  if (!collabAPI) {
    return null;
  }
  return isGuest ? (
    <GuestShareDialog collabAPI={collabAPI} handleClose={handleClose} />
  ) : (
    <OwnerShareDialog collabAPI={collabAPI} handleClose={handleClose} />
  );
};
