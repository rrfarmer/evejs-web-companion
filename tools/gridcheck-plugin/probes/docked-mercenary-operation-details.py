from evedungeons.client.data import GetDungeons
from evedungeons.client.util import GetDungeonShipRestrictions
from localization import GetByLabel, GetByMessageID
from metadata.common.content_tags import ContentTags
from jobboard.client.features.mercenary_tactical_operations.job import MTOJob

examples = []
for dungeon_id, row in GetDungeons().iteritems():
    message_id = getattr(row, 'dungeonNameID', None) or getattr(row, 'nameID', None)
    if not message_id:
        continue
    name = GetByMessageID(message_id)
    if not (ContentTags.feature_mercenary_tactical_ops in (getattr(row, 'contentTags', None) or ())
            or 'mercenary' in (name or '').lower()):
        continue
    restrictions = GetDungeonShipRestrictions(dungeon_id)
    examples.append(dict(id=dungeon_id, nameID=message_id, name=name,
                         gameplayID=getattr(row, 'gameplayDescriptionID', None),
                         difficulty=getattr(row, 'difficulty', None), restricted=bool(restrictions)))
    if len(examples) == 6:
        break

result = dict(station=session.stationid, objectiveChain=MTOJob.MTO_OBJECTIVE_CHAIN_ID,
              description=GetByLabel('UI/Common/Description'),
              intel=GetByLabel('UI/Dungeons/GameplayDescriptionHeader'),
              impacts=GetByLabel('UI/Agency/MercDen/JobDetailHeader'),
              status=GetByLabel('UI/Agency/MercDen/Status'),
              start=GetByLabel('UI/Sovereignty/MercenaryDen/StartOperation'),
              examples=examples)
