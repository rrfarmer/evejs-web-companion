import uuid
from cosmetics.client.ships.link.ship_skin_design_link_creation import create_link
from cosmetics.client.ships.link.ship_skin_design_link_handler import _parse_url
from eveProto.generated.eve_public.cosmetic.ship.skin.thirdparty.draft.api import requests_pb2
from localization import GetByLabel

listing_id = uuid.UUID('13622000-0000-4000-8000-000000000001')
link = create_link(session.charid, listing_id, 'Perimeter Amber')
owner, design = _parse_url(link.url)
prefix = 'UI/Personalization/ShipSkins/'
messages = {}
for cls in (requests_pb2.GetSharedRequest, requests_pb2.GetSharedResponse):
    descriptor = cls.DESCRIPTOR
    messages[descriptor.full_name] = dict(fields=[
        dict(name=f.name, number=f.number, type=f.type, label=f.label, typeName=f.message_type.full_name)
        for f in descriptor.fields])

result = dict(station=session.stationid, owner=owner, design=str(design), url=link.url, text=link.text,
              hover=GetByLabel(prefix + 'LinkHint'), share=GetByLabel(prefix + 'SKINR/Studio/ShareDesign'),
              missing=GetByLabel(prefix + 'DesignLinkNotFound'), failed=GetByLabel(prefix + 'DesignLinkFailed'),
              schema=dict(messages=messages, enums={}))
