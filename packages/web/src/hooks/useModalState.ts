import { useState } from "react";

export function useModalState() {
  const [workspaceModalOpen, setWorkspaceModalOpen] = useState(false);
  const [workspaceSettingsModalOpen, setWorkspaceSettingsModalOpen] = useState(false);
  const [globalSettingsModalOpen, setGlobalSettingsModalOpen] = useState(false);
  const [taskModalOpen, setTaskModalOpen] = useState(false);

  return {
    workspaceModalOpen,
    workspaceSettingsModalOpen,
    globalSettingsModalOpen,
    taskModalOpen,
    setWorkspaceModalOpen,
    setWorkspaceSettingsModalOpen,
    setGlobalSettingsModalOpen,
    setTaskModalOpen
  };
}
