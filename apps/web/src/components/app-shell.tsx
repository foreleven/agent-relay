"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Bot, CalendarClock, Container, LayoutDashboard, LogOut, MessageSquareText, RadioTower, User } from "lucide-react";

import { getMe, logout } from "@/lib/api";
import type { AccountInfo } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";

const navItems = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/channels", label: "Channels", icon: RadioTower },
  { href: "/agents", label: "Agents", icon: Bot },
  { href: "/sandboxes", label: "Sandboxes", icon: Container },
  { href: "/messages", label: "Messages", icon: MessageSquareText },
  { href: "/scheduled-tasks", label: "Scheduled Tasks", icon: CalendarClock },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [account, setAccount] = useState<AccountInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getMe()
      .then((me) => {
        if (cancelled) return;
        setAccount(me);
        if (!me) {
          void logout().finally(() => {
            router.push("/login");
            router.refresh();
          });
        }
      })
      .catch(() => {
        if (!cancelled) setAccount(null);
      });
    return () => {
      cancelled = true;
    };
  }, [pathname, router]);

  async function handleLogout() {
    await logout().catch(() => undefined);
    setAccount(null);
    router.push("/login");
    router.refresh();
  }

  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-64 shrink-0 flex-col border-r border-border bg-card px-4 py-5 md:flex">
        <Link href="/" className="mb-8 flex items-center gap-3 px-2">
          <span className="flex size-9 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <RadioTower className="size-4" />
          </span>
          <span>
            <span className="block text-sm font-semibold">Agent Relay</span>
            <span className="block text-xs text-muted-foreground">
              Gateway Admin
            </span>
          </span>
        </Link>
        <nav className="flex flex-col gap-1">
          {navItems.map((item) => {
            const active =
              item.href === "/"
                ? pathname === "/"
                : pathname.startsWith(item.href);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex h-9 items-center gap-2 rounded-md px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground",
                  active && "bg-accent text-accent-foreground",
                )}
              >
                <Icon className="size-4" />
                {item.label}
              </Link>
            );
          })}
        </nav>

        <Separator className="mt-auto" />
        <div className="pt-4">
          {account ? (
            <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
              <div className="flex min-w-0 items-center gap-2">
                <User className="size-4 shrink-0 text-muted-foreground" />
                <span className="truncate text-sm font-medium">
                  {account.username}
                </span>
              </div>
              <Button
                aria-label="Log out"
                className="ml-2 shrink-0"
                onClick={handleLogout}
                size="icon"
                type="button"
                variant="ghost"
              >
                <LogOut />
              </Button>
            </div>
          ) : (
            <Link
              href="/login"
              className="flex h-9 items-center gap-2 rounded-md px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
            >
              <User className="size-4" />
              Sign In
            </Link>
          )}
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center gap-2 border-b border-border bg-card px-4 md:hidden">
          {navItems.map((item) => {
            const active =
              item.href === "/"
                ? pathname === "/"
                : pathname.startsWith(item.href);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex h-9 flex-1 items-center justify-center gap-2 rounded-md text-xs font-medium text-muted-foreground",
                  active && "bg-accent text-accent-foreground",
                )}
              >
                <Icon className="size-4" />
                {item.label}
              </Link>
            );
          })}
          {account && (
            <Button
              aria-label="Log out"
              className="shrink-0"
              onClick={handleLogout}
              size="icon"
              type="button"
              variant="ghost"
            >
              <LogOut />
            </Button>
          )}
        </header>
        <main className="flex-1 p-4 sm:p-6">{children}</main>
      </div>
    </div>
  );
}
