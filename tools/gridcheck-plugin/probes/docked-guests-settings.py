# Read the native Guests density setting in both modes and restore its value.
import blue
import localization
from eve.client.script.ui.shared.dockedUI.guests import guest_list_compact_mode_setting
from eve.client.script.ui.shared.dockedUI.lobbyWnd import GUESTSPANEL, LobbyWnd

lobby = LobbyWnd.GetIfOpen()
if not lobby:
    raise RuntimeError('Docked lobby is not open')

tabs = lobby._tabs
previous_tab = tabs.GetSelectedID()
tabs.SelectByID(GUESTSPANEL)
panel = lobby._guests_panel
setting = guest_list_compact_mode_setting
previous_value = setting.is_enabled()
try:
    samples = []
    for compact in (False, True):
        setting.set(compact)
        expected_class = 'UserSimple' if compact else 'User'
        for attempt in range(40):
            nodes = panel._scroll.GetNodes()
            if nodes and nodes[0].decoClass.__name__ == expected_class:
                break
            blue.synchro.SleepWallclock(100)
        else:
            raise RuntimeError('Guests did not use %s' % expected_class)
        node = nodes[0]
        samples.append({
            'compact': setting.is_enabled(),
            'entry': node.decoClass.__name__,
            'height': node.decoClass.GetDynamicHeight(node, 200),
            'name': node.label,
        })
    result = {
        'station': session.stationid,
        'structure': session.structureid,
        'label': localization.GetByLabel('UI/Chat/ShowCompactMemberList'),
        'tooltip': localization.GetByLabel('UI/Chat/UserlistSettingButtonHint'),
        'initialCompact': previous_value,
        'samples': samples,
    }
finally:
    setting.set(previous_value)
    if previous_tab and previous_tab != GUESTSPANEL:
        tabs.SelectByID(previous_tab)
