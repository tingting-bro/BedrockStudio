import { useEffect, useState } from "react";
import { Toaster, toast } from "sonner";
import { api, type DocumentState } from "@/lib/api";
import { APP_CLOSE_PROMPT } from "@/lib/constants";
import AppSettings from "@/components/AppSettings";
import {
  applyPreferences,
  defaultPreferences,
  setSettingsOpen as blockSettingsShortcuts,
  type Preferences,
} from "@/lib/preferences";
import LoadingIndicator from "@/components/LoadingIndicator";
import WorldPicker from "@/features/worlds/WorldPicker";
import Editor from "@/features/editor/Editor";
import ModePicker from "@/features/worlds/ModePicker";
import ChunkEditor from "@/features/chunks/ChunkEditor";
import { cancelDesktopClose, finishDesktopClose } from "@/lib/desktop";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";

export default function App() {
  const [document, setDocument] = useState<DocumentState | null>(null);
  const [mode, setMode] = useState<"nbt" | "chunks" | null>(null);
  const [windowCloseRequested, setWindowCloseRequested] = useState(false);
  const [closing, setClosing] = useState(false);
  const [preferences, setPreferences] = useState(defaultPreferences);
  const [preferencesReady, setPreferencesReady] = useState(false);
  const [preferencesError, setPreferencesError] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [openSourceNoticeOpen, setOpenSourceNoticeOpen] = useState(true);
  useEffect(() => {
    let active = true;
    api<Preferences>("/preferences")
      .then((value) => {
        if (active) {
          applyPreferences(value);
          setPreferences(value);
        }
      })
      .catch((error) => {
        if (active) setPreferencesError(error.message);
      })
      .finally(() => {
        if (active) setPreferencesReady(true);
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    globalThis.document.documentElement.dataset.reducedMotion = String(
      preferences.reduced_motion,
    );
  }, [preferences]);
  function openSettings(open = true) {
    blockSettingsShortcuts(open);
    setSettingsOpen(open);
  }
  useEffect(() => {
    window.bedrockDesktop = {
      requestClose: () => setWindowCloseRequested(true),
      allowClose: false,
    };
    return () => {
      delete window.bedrockDesktop;
    };
  }, []);
  function cancelClose() {
    setWindowCloseRequested(false);
    cancelDesktopClose();
  }
  async function closeWindow() {
    setClosing(true);
    try {
      await finishDesktopClose();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setClosing(false);
    }
  }
  return (
    <>
      {!preferencesReady ? (
        <div className="app-preparing" role="status">
          正在读取应用设置…
        </div>
      ) : document && mode === "nbt" ? (
        <Editor
          initial={document}
          onSettings={() => openSettings()}
          onClose={() => {
            setDocument(null);
            setMode(null);
          }}
          windowCloseRequested={windowCloseRequested}
          onCancelWindowClose={cancelClose}
        />
      ) : document && mode === "chunks" ? (
        <ChunkEditor
          onSettings={() => openSettings()}
          initial={document}
          onBack={(next) => {
            setDocument(next);
            setMode(null);
          }}
          windowCloseRequested={windowCloseRequested}
          onCancelWindowClose={cancelClose}
        />
      ) : document ? (
        <ModePicker
          onSettings={() => openSettings()}
          doc={document}
          onChoose={setMode}
          onClose={() => setDocument(null)}
        />
      ) : (
        <WorldPicker
          preferences={preferences}
          onSettings={() => openSettings()}
          onOpen={(next) => {
            setDocument(next);
            setMode(null);
          }}
        />
      )}
      <LoadingIndicator />
      <AppSettings
        open={settingsOpen}
        value={preferences}
        loadError={preferencesError}
        onOpenChange={openSettings}
        onSaved={(value) => {
          applyPreferences(value);
          setPreferences(value);
          setPreferencesError("");
        }}
      />
      <Toaster theme="light" position="bottom-right" richColors closeButton />
      <Dialog open={preferencesReady && openSourceNoticeOpen} onOpenChange={setOpenSourceNoticeOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Bedrock Studio 是开源项目</DialogTitle>
            <DialogDescription>
              本项目以开源方式发布，欢迎查看源码、反馈问题并参与改进。
            </DialogDescription>
          </DialogHeader>
          <p>
            项目源码与许可证信息：{" "}
            <a href="https://github.com/tingting-bro/BedrockStudio" target="_blank" rel="noreferrer">
              github.com/tingting-bro/BedrockStudio
            </a>
          </p>
          <DialogFooter>
            <Button onClick={() => setOpenSourceNoticeOpen(false)}>知道了</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={windowCloseRequested && (!document || mode === null)}
        onOpenChange={(open) => {
          if (!open && !closing) cancelClose();
        }}
      >
        <DialogContent
          showCloseButton={!closing}
          onEscapeKeyDown={(e) => {
            if (closing) e.preventDefault();
          }}
          onPointerDownOutside={(e) => e.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle>关闭程序？</DialogTitle>
            <DialogDescription>{APP_CLOSE_PROMPT}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={cancelClose} disabled={closing}>
              取消
            </Button>
            <Button onClick={() => void closeWindow()} disabled={closing}>
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
