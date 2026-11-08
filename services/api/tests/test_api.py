from app.main import ChatRequest

def test_chat_schema():
    msg = ChatRequest(text="Привет")
    assert msg.image is None
