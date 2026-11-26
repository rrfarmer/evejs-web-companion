from localization import GetByMessageID
from sovereignty.mercenaryden.client.mocks.request_messenger_mock import MockMercenaryDenRequestMessenger

activities, _ = MockMercenaryDenRequestMessenger().get_all_activities_for_den_request(990000013583)
activity = activities[0]
result = dict(station=session.stationid, title=GetByMessageID(activity.template_name_id),
              description=GetByMessageID(activity.template_description_id),
              nameID=activity.template_name_id, descriptionID=activity.template_description_id,
              dungeonID=activity.dungeon_id, development=activity.development_impact,
              anarchy=activity.anarchy_impact, infomorphs=activity.infomorph_bonus)
