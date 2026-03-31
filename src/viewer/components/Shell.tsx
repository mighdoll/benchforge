import { useEffect } from "preact/hooks";
import { provider, sourceTabs } from "../State.ts";
import { openSourceTab } from "./SourcePanel.tsx";
import { TabBar } from "./TabBar.tsx";
import { TabContent } from "./TabContent.tsx";

export function Shell() {
  useEffect(() => {
    function onMessage(ev: MessageEvent): void {
      if (ev.data?.type === "open-source") {
        const { file, line, col } = ev.data;
        if (file) openSourceTab(file, line, col);
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  return (
    <>
      <TabBar />
      <TabContent />
    </>
  );
}
