import type { Automation } from "@open-inspect/shared";
import { Badge } from "@/components/ui/badge";
import { getAutomationDisplayStatus } from "@/lib/automation-status";

export function AutomationStatusBadge({ automation }: { automation: Automation }) {
  const status = getAutomationDisplayStatus(automation);

  if (status === "degraded") {
    return (
      <Badge className="bg-warning-muted text-warning">
        Degraded ({automation.consecutiveFailures} failures)
      </Badge>
    );
  }
  if (status === "enabled") {
    return <Badge className="bg-success-muted text-success">Enabled</Badge>;
  }
  return <Badge className="bg-muted text-muted-foreground">Paused</Badge>;
}
