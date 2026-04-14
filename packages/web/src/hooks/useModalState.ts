import { useState } from "react";

export function useModalState() {
  const [workspaceModalOpen, setWorkspaceModalOpen] = useState(false);
  const [globalSettingsModalOpen, setGlobalSettingsModalOpen] = useState(false);
  const [taskModalOpen, setTaskModalOpen] = useState(false);
  return {
    workspaceModalOpen,
    globalSettingsModalOpen,
    taskModalOpen,
    setWorkspaceModalOpen,
    setGlobalSettingsModalOpen,
    setTaskModalOpen
  };
}
