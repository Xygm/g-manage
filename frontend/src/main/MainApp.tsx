import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef } from "react";
import {
  app, deleteWithUndo, filteredAccounts, loadAll, moveSelection, openTarget, accountById, copyTotp,
  copyPassword, refreshAll, refreshOne, reloadAccounts, select, visibleAccounts,
} from "../lib/app";
import { bindTitlebar, isNativeMac } from "../lib/bridge";
import { hasTextSelection, typing, useMedia } from "../lib/hooks";
import { useStore } from "../lib/store";
import { fade, spring } from "../lib/motion";
import { Drawer } from "../ui/overlay";
import { Toaster } from "../ui/toaster";
import { cx } from "../ui/button";
import { Header } from "./Header";
import { Toolbar } from "./Toolbar";
import { AccountList } from "./AccountList";
import { Inspector } from "./Inspector";
import { Palette } from "./Palette";
import { AccountSheet, ImportSheet, SettingsSheet } from "./Sheets";
import { ChromeBanner } from "./ChromeBanner";

export function MainApp() {
  const wide = useMedia("(min-width: 1040px)");
  const loaded = useStore(app, (s) => s.loaded);
  const selectedId = useStore(app, (s) => s.selectedId);
  const filtered = useStore(app, filteredAccounts);
  const hasDrawerSelection = useStore(app, (s) => !!s.selectedId && visibleAccounts(s).some((a) => a.id === s.selectedId));
  const headerRef = useRef<HTMLElement>(null);

  useEffect(() => {
    loadAll();
    bindTitlebar(headerRef.current);
  }, []);

  // 宽屏下若未选中或当前选中项不在当前筛选结果里，自动选中当前列表首条，避免左右两侧错位。
  useEffect(() => {
    if (!wide || !loaded) return;
    if (!filtered.length) return;
    if (!selectedId || !filtered.some((a) => a.id === selectedId)) {
      select(filtered[0].id);
    }
  }, [wide, loaded, selectedId, filtered]);

  // 从浏览器授权完切回来时自动拉一次最新状态。
  useEffect(() => {
    let last = 0;
    const onFocus = () => {
      if (Date.now() - last < 3000) return;
      last = Date.now();
      reloadAccounts();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const s = app.get();
      const modalOpen = !!s.sheet || s.palette;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        app.set({ palette: !s.palette });
        return;
      }
      if (modalOpen) return;
      if (mod && e.key === ",") {
        e.preventDefault();
        app.set({ sheet: { kind: "settings" } });
        return;
      }
      if (mod && e.key.toLowerCase() === "n") {
        e.preventDefault();
        app.set({ sheet: { kind: "add" } });
        return;
      }
      if (mod && e.key.toLowerCase() === "r") {
        e.preventDefault();
        if (e.shiftKey) refreshAll();
        else if (s.selectedId) refreshOne(s.selectedId);
        return;
      }
      if (mod && e.key.toLowerCase() === "f") {
        e.preventDefault();
        document.getElementById("list-search")?.focus();
        return;
      }
      if (typing()) return;
      const a = s.selectedId ? accountById(s.selectedId) : undefined;
      if (e.key === "/" && !mod) {
        e.preventDefault();
        document.getElementById("list-search")?.focus();
      } else if ((e.key === "ArrowDown" || e.key === "j") && !mod) {
        e.preventDefault();
        moveSelection(1);
      } else if ((e.key === "ArrowUp" || e.key === "k") && !mod) {
        e.preventDefault();
        moveSelection(-1);
      } else if (a && mod && e.key.toLowerCase() === "o") {
        e.preventDefault();
        openTarget(a, "browser");
      } else if (a && mod && e.key.toLowerCase() === "c" && !hasTextSelection()) {
        e.preventDefault();
        if (e.shiftKey) {
          if (a.has_password) copyPassword(a);
        } else if (a.has_totp) copyTotp(a);
      } else if (a && mod && e.key.toLowerCase() === "e") {
        e.preventDefault();
        app.set({ sheet: { kind: "edit", id: a.id } });
      } else if (a && mod && e.key === "Backspace") {
        e.preventDefault();
        deleteWithUndo(a);
      } else if (e.key === "Escape" && !wide && s.selectedId) {
        app.set({ selectedId: 0 });
      }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [wide]);

  return (
    <>
      <div className="flex h-full flex-col">
        <Header ref={headerRef} />
        <main className={cx("flex min-h-0 flex-1 gap-2 px-2 pb-2", isNativeMac && "pt-0")}>
          {/* 托盘：微内凹底，包着凸起的表面；外 20 = 内 14 + 6 */}
          <section className="flex min-w-0 flex-1 flex-col rounded-[20px] bg-tray-deep p-1.5 shadow-tray">
            <Toolbar />
            <ChromeBanner />
            <div className="relative min-h-0 flex-1 overflow-hidden rounded-[14px] bg-surface shadow-raised">
              <AccountList />
            </div>
          </section>
          <AnimatePresence initial={false}>
            {wide && (
              <motion.aside
                key="inspector"
                initial={{ opacity: 0, x: 16 }}
                animate={{ opacity: 1, x: 0, transition: spring.glide }}
                exit={{ opacity: 0, x: 16, transition: fade.out }}
                className="flex w-[392px] shrink-0 flex-col rounded-[20px] bg-tray-deep p-1.5 shadow-tray"
              >
                <div className="relative min-h-0 flex-1 overflow-hidden rounded-[14px] bg-surface shadow-raised">
                  <Inspector id={selectedId} />
                </div>
              </motion.aside>
            )}
          </AnimatePresence>
        </main>
      </div>
      {!wide && (
        <Drawer open={hasDrawerSelection} onClose={() => app.set({ selectedId: 0, unlockFor: null })}>
          <Inspector id={selectedId} inDrawer />
        </Drawer>
      )}
      <Palette />
      <AccountSheet />
      <SettingsSheet />
      <ImportSheet />
      <Toaster />
    </>
  );
}
