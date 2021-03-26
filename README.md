# Poly Haven API

The public API used by polyhaven.com itself, as well as any third party applications.

Provides endpoints for getting lists of assets, categories, and information about individual assets as well.

## TODO:

* Download URLs and available formats/resolutions.

## `GET` Endpoints:

### `/assets`

A list of assets, including their individual metadata.

To filter the returned data, some **optional arguments** can by provided in the request URL (e.g. `/assets?type=hdris&categories=outdoor`):

* `type`/`t`: Return only assets of a particular type. Must be: `hdris`/`textures`/`models`.
* `categories`/`c`: A comma-separated list of categories to filter by. Only assets that match all categories specified will be returned.
* `search`/`s`: A string to search by.
* `author`/`a`: Specify the author ID.

### `/info/[id]`

Information about an individual asset specified by its unique ID.

E.g: `/info/brick_factory_02`

### `/categories/[type]`

Lists the available categories that all our assets are in, as well as the number of assets in each category.

The `type` must be one of the supported asset types (see `/types` endpoint below).

Returned data looks like this:

```js
{
  'outdoor': 339,
  'indoor': 121,
  'skies': 120,
  ...
}
```

Takes the following **optional arguments**:

* `in`: A comma separated list of categories - only returns categories with assets that are also in these categories. The value of each key is then also only counting assets that are in both the categories specified and the key.

### `/types`

Returns a list of asset types available, e.g:

```js
[
  'hdris',
  'textures',
  'models'
]
```

### `/collections`

Returns a list of collections available and the number of assets in them as key-value pairs.
