import { useState } from "react";

export function useModalState() {
  const [workspaceModalOpen, setWorkspaceModalOpen] = useState(false);
  const [workspaceSettingsModalOpen, setWorkspaceSettingsModalOpen] = useState(false);
  const [globalSettingsModalOpen, setGlobalSettingsModalOpen] = useState(false);
  const [taskModalOpen, setTaskModalOpen] = useState(false);
  const [teamModalOpen, setTeamModalOpen] = useState(false);

  return {
    workspaceModalOpen,
    workspaceSettingsModalOpen,
    globalSettingsModalOpen,
    taskModalOpen,
    teamModalOpen,
    setWorkspaceModalOpen,
    setWorkspaceSettingsModalOpen,
    setGlobalSettingsModalOpen,
    setTaskModalOpen,
    setTeamModalOpen
  };
}
