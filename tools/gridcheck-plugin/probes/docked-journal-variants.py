import carbonui.const as uiconst
from eve.client.script.ui import eveCommands as commands
from eve.client.script.ui.shared.neocom import journal
from eve.client.script.ui.shared.neocom.neocom import neocomRawData as raw
from localization import GetByLabel
import neocom2.btnIDs as ids


def observe():
    cmd = sm.GetService('cmd')
    native_flags = [(module, key, getattr(module, key))
                    for module in (raw, commands)
                    for key in ('is_job_board_available', 'are_missions_in_job_board_available')]
    modes = []

    def read(board, missions):
        activities = next(group[2] for group in raw.GetEveMenuRawData() if group[1] == ids.GROUP_ACTIVITIES_ID)
        mapping = cmd.SetDefaultShortcutMappingGAME()
        accelerators = {entry.name: entry.shortcut for entry in mapping
                        if entry.name in ('OpenJournal', 'OpenJobBoardWindow')}
        return dict(board=board, missions=missions, journalInActivities=any(btn[1] == ids.JOURNAL_ID for btn in activities),
                    boardInActivities=any(btn[1] == ids.JOB_BOARD_ID for btn in activities),
                    pinnedBoard=any(btn[1] == ids.JOB_BOARD_ID for btn in raw.GetNeocomDefaultRawData()),
                    commands=accelerators)

    before = read(commands.is_job_board_available(), commands.are_missions_in_job_board_available())
    try:
        for board, missions in ((True, True), (True, False), (False, False)):
            for module, key, _ in native_flags:
                setattr(module, key, (lambda value=board: value) if key == 'is_job_board_available'
                        else (lambda value=missions: value))
            modes.append(read(board, missions))
        cls = journal.JournalWindow
        wnd = cls.Open()
        return dict(build=3698585, station=session.stationid, default=before, modes=modes,
                    shortcut=[uiconst.VK_MENU, uiconst.VK_J], title=GetByLabel(cls.default_captionLabelPath),
                    description=GetByLabel(cls.default_descriptionLabelPath), dimensions=[cls.default_width, cls.default_height],
                    minSize=list(cls.default_minSize), missions=GetByLabel('UI/PeopleAndPlaces/AgentMissions'),
                    empty=GetByLabel('UI/Journal/JournalWindow/Agents/NoMissionsOfferedOrAccepted'),
                    missionCount=len(sm.GetService('journal').GetMyAgentJournalDetails()[0]))
    finally:
        for module, key, value in native_flags:
            setattr(module, key, value)
        journal.JournalWindow.CloseIfOpen()


result = observe()
