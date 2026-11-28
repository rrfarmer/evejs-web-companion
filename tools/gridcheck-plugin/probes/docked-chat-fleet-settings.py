import uthread2
from carbonui.util.bunch import Bunch
from eveservices.xmppchat import GetChatService
from localization import GetByLabel
from xmppchatclient.xmppchannelsettings import ChannelSettingsDlg, GetFieldsFromConfig


def observe():
    if not session.stationid or session.fleetid:
        raise RuntimeError('This probe needs a docked pilot outside a fleet')
    chat = GetChatService()
    fleet = sm.GetService('fleet')
    dialog = None
    try:
        fleet.CreateFleet()
        for _ in range(40):
            room = 'fleet_%s' % session.fleetid
            window = chat.GetGroupChatWindow(room)
            if session.fleetid and window and fleet.IsBoss():
                break
            uthread2.sleep(0.25)
        entries = []
        window.MaybeAddSettingsOptionsToMenuParent(Bunch(AddIconEntry=lambda **kw: entries.append(kw)))
        labels = [getattr(row, 'text', None) for row in window.GetMenu().GetEntries()]
        entries[0]['callback']()
        dialog = ChannelSettingsDlg.GetIfOpen(windowID='ChannelSettingsDlg_%s' % room)
        name = dialog.channelName.GetValue()
        operator_only = dialog.operatorOnly
        dialog.motd.SetValue('Gridcheck Fleet MOTD 13870')
        dialog.OnOK()
        for _ in range(40):
            if fleet.GetMotd() == 'Gridcheck Fleet MOTD 13870':
                break
            uthread2.sleep(0.25)
        return dict(station=session.stationid, room=room, boss=fleet.IsBoss(), name=name,
                    owner=chat.IsOwnerOfChannel(room), operator=chat.IsOperatorOfChannel(room),
                    fields=sorted(GetFieldsFromConfig(chat.GetChannelConfig(room)) or {}),
                    context=GetByLabel('UI/Chat/Configuration') in labels,
                    gear=[entry['text'] for entry in entries], operatorOnly=operator_only, motd=fleet.GetMotd())
    finally:
        if dialog and not dialog.destroyed:
            dialog.Close()
        if session.fleetid:
            fleet.LeaveFleet()


result = observe()
