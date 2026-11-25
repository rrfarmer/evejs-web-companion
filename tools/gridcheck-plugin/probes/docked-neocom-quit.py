# Observe the docked Quit Game prompt and cancel it on the current native pilot.
import blue
from carbonui import uiconst
from neocom2.btnIDs import QUIT_GAME_ID


def wait_for_modal(opened):
    for _ in xrange(40):
        modal = uicore.registry.GetModalWindow()
        if bool(modal) == opened:
            return modal if opened else True
        blue.synchro.SleepWallclock(100)
    return None


def observe():
    service = sm.GetService('neocom')
    pilot = session.charid
    station = session.stationid
    observation = {'station': station, 'pilot': pilot, 'alreadyModal': bool(uicore.registry.GetModalWindow())}
    if observation['alreadyModal']:
        return observation
    modal = None
    try:
        panel = service.ShowEveMenu()
        rows = [entry for entry in panel.main.children if hasattr(entry, 'btnData')]
        quit_game = next(entry for entry in rows if entry.btnData.id == QUIT_GAME_ID)
        observation.update({'index': rows.index(quit_game), 'label': quit_game.GetLabel(),
                            'icon': quit_game.btnData.iconPath, 'command': quit_game.btnData.cmdName})
        quit_game.OnClick()
        modal = wait_for_modal(True)
        if modal:
            observation['prompt'] = getattr(modal, 'msgKey', None)
            modal.SetModalResult(uiconst.ID_NO)
            observation['canceled'] = bool(wait_for_modal(False))
        observation['pilotRetained'] = session.charid == pilot and session.stationid == station
        return observation
    finally:
        service.CloseAllPanels()
        if modal and uicore.registry.GetModalWindow() is modal:
            modal.SetModalResult(uiconst.ID_NO)


result = observe()
