# Observe the native launcher and the read-only Place Bounty route for the current pilot.
from eve.client.script.ui.services.menuSvcExtras.openFunctions import OpenBountyOffice
from eve.client.script.ui.shared.bountyWindow import BountyWindow
from globalConfig.getFunctions import IsPlayerBountyHidden
from localization import GetByLabel


def observe():
    cmd = sm.GetService('cmd')
    window = BountyWindow.GetIfOpen()
    observation = {
        'station': session.stationid,
        'hidden': bool(IsPlayerBountyHidden(sm.GetService('machoNet'))),
        'caption': GetByLabel(BountyWindow.default_captionLabelPath),
        'windowID': BountyWindow.default_windowID,
        'size': [BountyWindow.default_width, BountyWindow.default_height],
        'alreadyOpen': bool(window)}
    if window or observation['hidden']:
        return observation
    try:
        cmd.OpenBountyOffice()
        window = BountyWindow.GetIfOpen()
        observation['opened'] = bool(window)
        if window:
            observation['initialOwner'] = window.ownerID
            observation['initialSearch'] = bool(window.searchCont.display)
            OpenBountyOffice(session.charid)
            observation['sameWindow'] = BountyWindow.GetIfOpen() is window
            observation['targetOwner'] = window.ownerID
            observation['targetSearch'] = bool(window.searchCont.display)
            cmd.OpenBountyOffice()
            observation['closedByCommand'] = BountyWindow.GetIfOpen() is None
        return observation
    finally:
        window = BountyWindow.GetIfOpen()
        if window:
            window.Close()


result = observe()
