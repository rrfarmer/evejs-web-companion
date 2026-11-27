import blue
import evefleet
from evefleet.fleetAdvertObject import FleetAdvertCreationObject
from eve.client.script.ui.shared.fleet.fleetwindow import FleetWindow, PANEL_MYADVERT
from eve.client.script.ui.shared.fleet.fleetregister import RegisterFleetWindow


def observe():
    fleet = sm.GetService('fleet')
    if session.fleetid or FleetWindow.GetIfOpen() or RegisterFleetWindow.GetIfOpen():
        raise RuntimeError('A fresh docked pilot is required')
    try:
        fleet.CreateFleet()
        for _ in range(35):
            if session.fleetid and session.charid in fleet.members:
                break
            blue.pyos.synchro.SleepWallclock(200)
        window = FleetWindow.Open()
        window.tabGroup.ShowPanelByID(PANEL_MYADVERT)
        blue.pyos.synchro.SleepWallclock(400)
        entries = [entry.GetText() for entry in window.GetFleetMenuTop() if entry is not None and 'Advert' in entry.GetText()]
        panel = next(tab.sr.panel for tab in window.tabGroup.GetTabs() if tab.sr.args == PANEL_MYADVERT)
        panel.LoadPanel()
        fleet.OpenRegisterFleetWindow()
        editor = RegisterFleetWindow.GetIfOpen()
        result = dict(build=3698585, station=session.stationid, menu=entries, empty=panel.myAdvertCaption.text,
                      editor=dict(caption=editor.GetCaption(), size=list(editor.GetAbsolute())[2:], name=editor.sr.fleetName.GetValue()))
        editor.Close()
        advert = FleetAdvertCreationObject(fleetName='Codex Fleet Advert', description='Native reference advert',
                                          joinNeedsApproval=True, public_minStanding=5, public_minSecurity=0.0)
        advert.AddToInviteScopeMask(evefleet.INVITE_PUBLIC_OPEN)
        fleet.RegisterFleet(advert)
        for _ in range(25):
            if fleet.options.isRegistered:
                break
            blue.pyos.synchro.SleepWallclock(120)
        panel.LoadPanel()
        link = panel.dragIcon.GetDragData()[0].get_link()
        result['registered'] = dict(caption=panel.myAdvertCaption.text,
                                    menu=[entry.GetText() for entry in window.GetFleetMenuTop() if entry is not None and 'Advert' in entry.GetText()],
                                    details=panel.myAdvertText.text, link=[link.url, link.text])
        fleet.RemoveFleetFinderAdvert()
        fleet.currentFleetAd = None
        for _ in range(25):
            if not fleet.options.isRegistered:
                break
            blue.pyos.synchro.SleepWallclock(120)
        panel.LoadPanel()
        result['removed'] = panel.myAdvertCaption.text
        return result
    finally:
        RegisterFleetWindow.CloseIfOpen()
        FleetWindow.CloseIfOpen()
        if session.fleetid:
            fleet.LeaveFleet()


result = observe()
