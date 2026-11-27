import blue
from carbonui import const as uiconst
from carbonui.uicore import uicore
from eve.client.script.ui.shared.maps.browserwindow import MapBrowserWnd


def observe():
    if not session.stationid and not session.structureid:
        raise RuntimeError('A docked pilot is required')
    if MapBrowserWnd.GetIfOpen():
        raise RuntimeError('Map Browser is already open')
    commands = uicore.cmd
    shortcut = (uiconst.VK_F11,)
    command = commands.commandMap.GetCommandByShortcut(shortcut)
    try:
        commands.ExecuteCommand(command)
        for _ in range(40):
            window = MapBrowserWnd.GetIfOpen()
            if window:
                browser = window.sr.browser
                if len(browser.children) == 4 and all(browser.ids) and not browser.loadingMap:
                    break
            blue.pyos.synchro.SleepWallclock(100)
        else:
            raise RuntimeError('Map Browser did not load the current system')
        ids = [list(ids) for ids in window.sr.browser.ids]
        caption = window.GetCaption()
        commands.ExecuteCommand(command)
        blue.pyos.synchro.SleepWallclock(300)
        return dict(build=3698585, station=session.stationid, structure=session.structureid,
                    system=session.solarsystemid2, command=command.name, shortcut=list(shortcut),
                    ids=ids, caption=caption, closed=not MapBrowserWnd.GetIfOpen())
    finally:
        window = MapBrowserWnd.GetIfOpen()
        if window:
            window.Close()


result = observe()
