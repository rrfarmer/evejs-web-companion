# Measure the native Guests quick filter and restore the prior search and tab.
import blue
from eve.client.script.ui.shared.dockedUI.lobbyWnd import GUESTSPANEL, LobbyWnd

lobby = LobbyWnd.GetIfOpen()
if not lobby:
    raise RuntimeError('Docked lobby is not open')

tabs = lobby._tabs
previous_tab = tabs.GetSelectedID()
tabs.SelectByID(GUESTSPANEL)
panel = lobby._guests_panel
edit = panel._quick_filter
previous_query = edit.GetValue()
try:
    for attempt in range(40):
        if panel._controller.guest_list is not None:
            break
        blue.synchro.SleepWallclock(100)
    guests = panel._controller.guest_list.guests
    sample_name = sorted(guest.name for guest in guests)[0] if guests else cfg.eveowners.Get(session.charid).name
    queries = ['', sample_name[1:].swapcase(), '[gridcheck-no-guest]']
    samples = []
    for query in queries:
        edit.SetValue(query, docallback=0)
        edit.DoReload()
        names = sorted(guest.name for guest in panel._get_filtered_guests(guests))
        samples.append({'query': query, 'names': names})
    result = {
        'station': session.stationid,
        'structure': session.structureid,
        'rect': list(edit.GetAbsolute()),
        'maxLength': edit.maxletters,
        'samples': samples,
    }
finally:
    edit.SetValue(previous_query, docallback=0)
    edit.DoReload()
    if previous_tab and previous_tab != GUESTSPANEL:
        tabs.SelectByID(previous_tab)
