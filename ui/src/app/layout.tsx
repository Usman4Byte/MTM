import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Mind to Machine | Hackathon Planner",
  description: "A focused workspace for reviewing a hackathon plan, trace, and incoming messages.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
