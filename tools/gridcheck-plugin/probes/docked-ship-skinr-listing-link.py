import uuid
from cosmetics.client.ships.link.ship_skin_listing_link_creation import create_link
from cosmetics.client.ships.link.ship_skin_listing_link_handler import _parse_url
from eveProto.generated.eve_public.cosmetic.market.skin.listing.api import api_pb2
from localization import GetByLabel

listing_id = uuid.UUID('13621000-0000-4000-8000-000000000001')
link = create_link(listing_id, 'Perimeter Amber')
prefix = 'UI/Personalization/ShipSkins/'

result = dict(station=session.stationid, url=link.url, text=link.text,
              parses=str(_parse_url(link.url)), invalid=_parse_url('shipSkinListing:invalid') is None,
              hover=GetByLabel(prefix + 'ShipSkinListingLinkHint'),
              share=GetByLabel(prefix + 'SKINR/Store/DragToShareShipSkinListing'),
              missing=GetByLabel(prefix + 'SKINR/Studio/ListingErrors/ListingNotFound'),
              request=api_pb2.GetRequest.DESCRIPTOR.full_name, response=api_pb2.GetResponse.DESCRIPTOR.full_name)
