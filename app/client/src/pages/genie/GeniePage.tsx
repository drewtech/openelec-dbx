import { GenieChat, Tabs, TabsContent, TabsList, TabsTrigger } from '@databricks/appkit-ui/react'
import { CustomGenieChat } from './CustomGenieChat'

export function GeniePage() {
  return (
    <div className="mx-auto w-full max-w-4xl space-y-4">
      <div>
        <h2 className="text-2xl font-bold text-foreground">Genie</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          OpenElectricity NEM Genie space, running as this Databricks App&apos;s service principal — one
          identity for every visitor, same as the standalone site&apos;s chat mode. Requires a Databricks
          login (Free Edition: this workspace&apos;s single user only).
        </p>
      </div>
      <Tabs defaultValue="appkit">
        <TabsList>
          <TabsTrigger value="appkit">AppKit GenieChat</TabsTrigger>
          <TabsTrigger value="custom">Custom UI (useGenieChat)</TabsTrigger>
        </TabsList>
        <TabsContent value="appkit" className="h-[min(600px,70vh)] overflow-hidden rounded-lg border">
          <GenieChat alias="default" />
        </TabsContent>
        <TabsContent value="custom" className="h-[min(600px,70vh)] overflow-hidden rounded-lg border p-4">
          <CustomGenieChat />
        </TabsContent>
      </Tabs>
    </div>
  )
}
