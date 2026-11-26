import uthread2
from eveservices.xmppchat import GetChatService
from globalConfig.getFunctions import GetUpdateChannelCountIntervalSeconds
from localization import GetByLabel


room = 'system_263238_263262'
chat = GetChatService()
already_joined = bool(chat.IsJoined(room))
before = chat.GetNumChannelOccupants(room)
try:
    if not already_joined:
        chat.JoinChannel(room, suppressMessage=True)
    during = chat.GetNumChannelOccupants(room)
    for _ in range(10):
        if during > 0:
            break
        uthread2.sleep(0.2)
        during = chat.GetNumChannelOccupants(room)
finally:
    if not already_joined and chat.IsJoined(room):
        chat.LeaveChannel(room)
after = chat.GetNumChannelOccupants(room)
result = dict(station=session.stationid, room=room, before=before, during=during, after=after,
              interval=GetUpdateChannelCountIntervalSeconds(sm.GetService('machoNet')),
              label=GetByLabel('UI/Chat/ChannelWindow/Members'))
