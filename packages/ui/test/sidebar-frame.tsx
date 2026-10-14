import type { ReactNode } from "react";
import { Sidebar } from "../src/sidebar";
import { SidebarHeader } from "../src/sidebar-nav";
import { SidebarToggle, TabStrip, type WindowPlatform } from "../src/tab-strip";
import { STRIP } from "./fixture";

export function SidebarFrame({
  children,
  floating = false,
  open,
  platform = "darwin",
}: {
  readonly children: ReactNode;
  readonly floating?: boolean;
  readonly open: boolean;
  readonly platform?: WindowPlatform;
}) {
  return (
    <Sidebar
      floating={floating}
      onFloatingChange={() => undefined}
      onToggle={() => undefined}
      onWidthCommit={() => undefined}
      open={open}
      width={252}
    >
      <TabStrip {...STRIP} platform={platform} />
      <Sidebar.Gap />
      <Sidebar.Container>
        <SidebarHeader actions={open ? <SidebarToggle /> : null} brand={null} />
        {children}
      </Sidebar.Container>
    </Sidebar>
  );
}
