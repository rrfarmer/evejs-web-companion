import blue
from eve.client.script.ui.shared.neocom.help import HelpWindow
from neocom2.btnIDs import HELP_ID


def observe():
    service = sm.GetService('neocom')
    if HelpWindow.GetIfOpen():
        return {'alreadyOpen': True}
    try:
        panel = service.ShowEveMenu()
        rows = [entry for entry in panel.main.children if hasattr(entry, 'btnData')]
        entry = next(row for row in rows if row.btnData.id == HELP_ID)
        rail = [node.id for node in service.mainBtnDataRoot.children]
        observation = {'station': session.stationid, 'rail': rail, 'footerIndex': rows.index(entry),
                       'command': entry.btnData.cmdName, 'label': entry.GetLabel()}
        entry.OnClick()
        for _ in xrange(40):
            window = HelpWindow.GetIfOpen()
            if window and getattr(window, 'mainCont', None):
                break
            blue.synchro.SleepWallclock(100)
        if window:
            blue.synchro.SleepWallclock(500)
            observation.update({'windowID': window.default_windowID, 'width': window.width})
            def button_names(node):
                names = [node.name] if node.name in ('helpChannelButton', 'openHelpCenterButton', 'filePetitionButton', 'reportBugButton') else []
                for child in getattr(node, 'children', []):
                    names.extend(button_names(child))
                return names
            observation['buttons'] = button_names(window.mainCont)
        return observation
    finally:
        service.CloseAllPanels()
        window = HelpWindow.GetIfOpen()
        if window:
            window.Close()


result = observe()
