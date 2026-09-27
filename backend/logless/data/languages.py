"""Closed public vocabulary for imported language metadata.

Input language labels are untrusted record data, not text approved for publication. Only
these fixed labels may enter the aggregate language breakdown; unknown labels are withheld
as "Unknown". This does not alter the conversation text or restrict model classification.
"""
from __future__ import annotations

import re

# Supported ISO 639-1 codes and canonical English display names. This is a bounded
# vocabulary, not a claim to recognize every language or arbitrary language descriptions.
BY_CODE = {
    "af": "Afrikaans", "sq": "Albanian", "am": "Amharic", "ar": "Arabic",
    "hy": "Armenian", "as": "Assamese", "az": "Azerbaijani", "eu": "Basque",
    "be": "Belarusian", "bn": "Bengali", "bs": "Bosnian", "bg": "Bulgarian",
    "my": "Burmese", "ca": "Catalan", "zh": "Chinese", "hr": "Croatian",
    "cs": "Czech", "da": "Danish", "nl": "Dutch", "en": "English",
    "eo": "Esperanto", "et": "Estonian", "fi": "Finnish", "fr": "French",
    "gl": "Galician", "ka": "Georgian", "de": "German", "el": "Greek",
    "gu": "Gujarati", "ht": "Haitian Creole", "ha": "Hausa", "he": "Hebrew",
    "hi": "Hindi", "hu": "Hungarian", "is": "Icelandic", "ig": "Igbo",
    "id": "Indonesian", "ga": "Irish", "it": "Italian", "ja": "Japanese",
    "jv": "Javanese", "kn": "Kannada", "kk": "Kazakh", "km": "Khmer",
    "ko": "Korean", "ku": "Kurdish", "ky": "Kyrgyz", "lo": "Lao",
    "la": "Latin", "lv": "Latvian", "lt": "Lithuanian", "lb": "Luxembourgish",
    "mk": "Macedonian", "mg": "Malagasy", "ms": "Malay", "ml": "Malayalam",
    "mt": "Maltese", "mi": "Maori", "mr": "Marathi", "mn": "Mongolian",
    "ne": "Nepali", "no": "Norwegian", "nb": "Norwegian Bokmål", "nn": "Norwegian Nynorsk",
    "or": "Odia", "ps": "Pashto", "fa": "Persian", "pl": "Polish",
    "pt": "Portuguese", "pa": "Punjabi", "ro": "Romanian", "ru": "Russian",
    "sm": "Samoan", "sa": "Sanskrit", "gd": "Scottish Gaelic", "sr": "Serbian",
    "sn": "Shona", "sd": "Sindhi", "si": "Sinhala", "sk": "Slovak",
    "sl": "Slovenian", "so": "Somali", "es": "Spanish", "su": "Sundanese",
    "sw": "Swahili", "sv": "Swedish", "tl": "Tagalog", "tg": "Tajik",
    "ta": "Tamil", "tt": "Tatar", "te": "Telugu", "th": "Thai",
    "bo": "Tibetan", "tr": "Turkish", "tk": "Turkmen", "uk": "Ukrainian",
    "ur": "Urdu", "ug": "Uyghur", "uz": "Uzbek", "vi": "Vietnamese",
    "cy": "Welsh", "xh": "Xhosa", "yi": "Yiddish", "yo": "Yoruba", "zu": "Zulu",
}
BY_NAME = {name.casefold(): name for name in BY_CODE.values()}
BY_NAME.update({"norwegian bokmal": BY_CODE["nb"], "oriya": BY_CODE["or"]})
LANGUAGE_TAG = re.compile(r"^[a-z]{2}(?:[-_][a-z0-9]{2,8})*$")


def canonical_language(value: str | None) -> str:
    if value is None:
        return "Unknown"
    value = value.strip().casefold()
    if value in BY_NAME:
        return BY_NAME[value]
    if LANGUAGE_TAG.fullmatch(value):
        return BY_CODE.get(re.split(r"[-_]", value, maxsplit=1)[0], "Unknown")
    return "Unknown"
