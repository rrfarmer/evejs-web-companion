import uthread2
from eveservices.xmppchat import GetChatService
from localization import GetByLabel


chat = GetChatService()
rooms = []
for name in ('English Help', 'EveJS Elysian chat'):
    room = chat.GetChannelByDisplayName(name)[0][0]
    already = bool(chat.IsJoined(room))
    try:
        if not already:
            chat.JoinChannel(room, suppressMessage=True)
            for _ in range(10):
                if chat.IsJoined(room):
                    break
                uthread2.sleep(0.2)
        joined = bool(chat.IsJoined(room))
    finally:
        if not already:
            chat.LeaveChannel(room)
            for _ in range(10):
                if not chat.IsJoined(room):
                    break
                uthread2.sleep(0.2)
    rooms.append(dict(room=room, name=name, before=already, joined=joined, after=bool(chat.IsJoined(room))))

result = dict(station=session.stationid, rooms=rooms,
              labels=[GetByLabel('UI/Chat/ChannelWindow/Join'), GetByLabel('UI/Chat/ChannelWindow/Leave')])
