import { CaptureUpdateAction, useExcalidrawAPI } from "@excalidraw/excalidraw";
import {
  PlusIcon,
  TrashIcon,
  pencilIcon,
} from "@excalidraw/excalidraw/components/icons";
import {
  restoreAppState,
  restoreElements,
} from "@excalidraw/excalidraw/data/restore";
import clsx from "clsx";
import { useCallback, useEffect, useState } from "react";

import {
  createCanvas,
  deleteCanvas,
  getCanvasSaveStatus,
  getCurrentCanvasId,
  getSceneFileIds,
  listCanvases,
  loadCanvasFiles,
  openCanvas,
  renameCanvas,
  subscribeToCanvasSaveStatus,
} from "../data/CanvasStore";
import { updateStaleImageStatuses } from "../data/FileManager";
import { LocalData } from "../data/LocalData";

import "./CanvasesPanel.scss";

import type { CanvasMeta, CanvasSaveStatus } from "../data/CanvasStore";

const SAVE_STATUS_LABEL: Record<CanvasSaveStatus, string> = {
  saved: "All changes saved",
  saving: "Saving…",
  error: "Not saved, server unreachable",
};

const formatDate = (timestamp: number) =>
  new Date(timestamp).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });

export const CanvasesPanel = () => {
  const excalidrawAPI = useExcalidrawAPI();
  const [canvases, setCanvases] = useState<CanvasMeta[] | null>(null);
  const [currentId, setCurrentId] = useState(getCurrentCanvasId());
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState(getCanvasSaveStatus());

  useEffect(() => subscribeToCanvasSaveStatus(setSaveStatus), []);

  const refresh = useCallback(async () => {
    try {
      setCanvases(await listCanvases());
      setCurrentId(getCurrentCanvasId());
    } catch (error: any) {
      setError(`Couldn't load canvases: ${error.message}`);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // the list is ordered by last edit, so refresh it once a save lands
  useEffect(() => {
    if (saveStatus === "saved") {
      refresh();
    }
  }, [saveStatus, refresh]);

  const run = async (action: () => Promise<void>) => {
    setIsBusy(true);
    setError(null);
    try {
      await action();
    } catch (error: any) {
      setError(error.message);
    } finally {
      setIsBusy(false);
      refresh();
    }
  };

  const switchTo = async (id: string) => {
    if (!excalidrawAPI) {
      return;
    }
    // stop saving the scene on screen under the new canvas id until the
    // new canvas has replaced it
    LocalData.flushSave();
    LocalData.pauseSave("canvasSwitch");
    try {
      const { canvas, scene } = await openCanvas(id);
      const elements = restoreElements(scene.elements, null, {
        repairBindings: true,
        deleteInvisibleElements: true,
      });
      excalidrawAPI.updateScene({
        elements,
        appState: {
          ...restoreAppState(scene.appState, excalidrawAPI.getAppState()),
          name: canvas.name,
        },
        captureUpdate: CaptureUpdateAction.NEVER,
      });
      excalidrawAPI.history.clear();
      setCurrentId(id);
      // scroll and zoom aren't stored on the server
      if (elements.length) {
        excalidrawAPI.setViewport({
          target: elements,
          fit: "scale-down",
          animation: false,
        });
      }

      const fileIds = getSceneFileIds(elements);
      if (fileIds.length) {
        loadCanvasFiles(fileIds).then(({ loadedFiles, erroredFiles }) => {
          if (loadedFiles.length) {
            excalidrawAPI.addFiles(loadedFiles);
          }
          updateStaleImageStatuses({
            excalidrawAPI,
            erroredFiles,
            elements: excalidrawAPI.getSceneElementsIncludingDeleted(),
          });
        });
      }
    } finally {
      LocalData.resumeSave("canvasSwitch");
    }
  };

  const onCreate = () =>
    run(async () => {
      const name = window.prompt("Name of the new canvas", "Untitled");
      if (name === null) {
        return;
      }
      const canvas = await createCanvas(name.trim() || "Untitled");
      await switchTo(canvas.id);
    });

  const onRename = (canvas: CanvasMeta) =>
    run(async () => {
      const name = window.prompt("Rename canvas", canvas.name);
      if (!name?.trim() || name.trim() === canvas.name) {
        return;
      }
      const renamed = await renameCanvas(canvas.id, name.trim());
      if (canvas.id === getCurrentCanvasId()) {
        excalidrawAPI?.updateScene({
          appState: { name: renamed.name },
          captureUpdate: CaptureUpdateAction.NEVER,
        });
      }
    });

  const onDelete = (canvas: CanvasMeta) =>
    run(async () => {
      if (!window.confirm(`Delete "${canvas.name}"?`)) {
        return;
      }
      if (canvas.id === getCurrentCanvasId()) {
        // open another canvas first so the deleted one isn't saved again
        const next =
          canvases?.find((other) => other.id !== canvas.id) ||
          (await createCanvas("Untitled"));
        await switchTo(next.id);
      }
      await deleteCanvas(canvas.id);
    });

  return (
    <div className="canvases-panel">
      <div className="canvases-panel__header">
        <button
          type="button"
          className="canvases-panel__new"
          onClick={onCreate}
          disabled={isBusy}
        >
          {PlusIcon}
          <span>New canvas</span>
        </button>
        <div
          className={clsx("canvases-panel__status", {
            "canvases-panel__status--error": saveStatus === "error",
          })}
        >
          {SAVE_STATUS_LABEL[saveStatus]}
        </div>
      </div>
      {error && <div className="canvases-panel__error">{error}</div>}
      {canvases === null ? (
        <div className="canvases-panel__empty">Loading…</div>
      ) : !canvases.length ? (
        <div className="canvases-panel__empty">No canvases yet</div>
      ) : (
        <ul className="canvases-panel__list">
          {canvases.map((canvas) => (
            <li
              key={canvas.id}
              className={clsx("canvases-panel__item", {
                "canvases-panel__item--active": canvas.id === currentId,
              })}
            >
              <button
                type="button"
                className="canvases-panel__open"
                onClick={() =>
                  canvas.id !== currentId && run(() => switchTo(canvas.id))
                }
                disabled={isBusy}
                title={canvas.name}
              >
                <span className="canvases-panel__name">{canvas.name}</span>
                <span className="canvases-panel__date">
                  {formatDate(canvas.updatedAt)}
                </span>
              </button>
              <button
                type="button"
                className="canvases-panel__action"
                onClick={() => onRename(canvas)}
                disabled={isBusy}
                title="Rename"
                aria-label={`Rename ${canvas.name}`}
              >
                {pencilIcon}
              </button>
              <button
                type="button"
                className="canvases-panel__action"
                onClick={() => onDelete(canvas)}
                disabled={isBusy}
                title="Delete"
                aria-label={`Delete ${canvas.name}`}
              >
                {TrashIcon}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
