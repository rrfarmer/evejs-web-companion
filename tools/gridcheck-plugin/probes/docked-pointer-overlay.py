import blue
from carbonui.uicore import uicore
from eve.client.script.ui.shared.pointerTool.pointerWnd import PointerToolWnd


def observe():
    commands = uicore.cmd
    command = commands.commandMap.GetCommandByName('CmdGetUiPointer')
    service = sm.GetService('helpPointer')
    original = command.shortcut
    was_open = bool(PointerToolWnd.GetIfOpen())
    try:
        command.shortcut = (0x77,)  # F8 for the observation only.
        commands.CmdGetUiPointer()
        overlay = service.GetPointerOverlay()
        for _ in range(40):
            if overlay.fillDict:
                break
            blue.pyos.synchro.SleepWallclock(50)
        targets = {}
        for name in ('neocom.wallet', 'unique_ui_stationSvc_repairshop'):
            pair = overlay.fillDict.get(name)
            if pair:
                fill, element = pair
                targets[name] = dict(fill=list(fill.GetAbsolute()), element=list(element.GetAbsolute()),
                                     drag=bool(fill.isDragObject), frame=list(fill.pointerFrame.color.GetRGBA()),
                                     tint=list(fill.pointerFill.color.GetRGBA()))
        active = overlay.isActive
        count = len(overlay.fillDict)
        commands._UnloadCombatCommand()
        return dict(station=session.stationid, shortcut=original, heldActive=active, heldCount=count,
                    windowBefore=was_open, windowAfter=bool(PointerToolWnd.GetIfOpen()), targets=targets,
                    activeAfter=overlay.isActive, countAfter=len(overlay.fillDict))
    finally:
        if commands.combatCmdLoaded is command:
            commands._UnloadCombatCommand()
        command.shortcut = original


result = observe()
