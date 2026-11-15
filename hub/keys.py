import os


def get(name):
    """Environment first, then ./.env, else "". Never prints values."""
    value = os.environ.get(name)
    if value:
        return value
    try:
        with open(".env") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, val = line.partition("=")
                if key.strip() == name:
                    return val.strip().strip("'\"")
    except OSError:
        pass
    return ""
