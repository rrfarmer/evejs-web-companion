# Read the installed EVE menu footer and open Settings through its menu entry.
import blue
from neocom2.btnIDs import SETTINGS_ID


def wait_for_open(layer, opened):
    for _ in xrange(40):
        if bool(layer.isopen) == opened:
            return True
        blue.synchro.SleepWallclock(100)
    return False


def observe():
    service = sm.GetService('neocom')
    layer = uicore.layer.systemmenu
    observation = {'station': session.stationid, 'alreadyOpen': bool(layer.isopen)}
    if layer.isopen:
        return observation
    try:
        panel = service.ShowEveMenu()
        rows = [entry for entry in panel.main.children if hasattr(entry, 'btnData')]
        settings = next(entry for entry in rows if entry.btnData.id == SETTINGS_ID)
        observation.update({
            'settingsIndex': rows.index(settings),
            'lastEntries': [entry.btnData.id for entry in rows[-5:]],
            'label': settings.btnData.label,
            'icon': settings.btnData.iconPath,
            'command': settings.btnData.cmdName})
        settings.OnClick()
        observation['opened'] = wait_for_open(layer, True)
        return observation
    finally:
        service.CloseAllPanels()
        if layer.isopen:
            uicore.cmd.CmdToggleSystemMenu()
            wait_for_open(layer, False)


result = observe()
