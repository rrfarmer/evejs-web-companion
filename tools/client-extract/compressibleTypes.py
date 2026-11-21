# The types the 3698585 client may compress (itemcompression.is_compressible_type: the compressibleTypes static data,
# itemcompression.data.cache), each with the type it compresses into. Read from a running client:
#   node tools/gridcheck/bin/gridcheck.js client eval --json --file tools/client-extract/compressibleTypes.py
# The page reads it as _local/client-assets/<build>/compressibleTypes.json: {source, pairs: [[sourceTypeID, compressedTypeID], ...]}.
from itemcompression import data
result = {'pairs': sorted([int(source), int(compressed)] for source, compressed in data.cache)}
