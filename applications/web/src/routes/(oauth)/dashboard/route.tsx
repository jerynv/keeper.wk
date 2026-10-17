import { createFileRoute, Outlet } from "@tanstack/react-router";

// Access already stands in front of every page, so there is no session to check here.
export const Route = createFileRoute("/(oauth)/dashboard")({
  component: OAuthDashboardLayout,
});

function OAuthDashboardLayout() {
  return <Outlet />;
}
