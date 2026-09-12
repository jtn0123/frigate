import {
  StatusBarMessagesContext,
  type StatusMessagesState,
} from "./statusbar-context";
import { useState, ReactNode, useCallback, useMemo } from "react";

type StatusBarMessagesProviderProps = {
  children: ReactNode;
};

export function StatusBarMessagesProvider({
  children,
}: StatusBarMessagesProviderProps) {
  const [messagesState, setMessagesState] = useState<StatusMessagesState>({});

  const messages = useMemo(() => messagesState, [messagesState]);

  const addMessage = useCallback(
    (
      key: string,
      message: string,
      color?: string,
      messageId?: string,
      link?: string,
    ) => {
      if (!key || !message) return;

      const id = messageId ?? Date.now().toString();
      const msgColor = color ?? "text-danger";

      setMessagesState((prevMessages) => {
        const existingMessages = prevMessages[key] || [];
        // Check if a message with the same ID already exists
        const messageIndex = existingMessages.findIndex((msg) => msg.id === id);

        const newMessage = { id, text: message, color: msgColor, link };

        // If the message exists, replace it, otherwise add the new message
        let updatedMessages;
        if (messageIndex > -1) {
          updatedMessages = [
            ...existingMessages.slice(0, messageIndex),
            newMessage,
            ...existingMessages.slice(messageIndex + 1),
          ];
        } else {
          updatedMessages = [...existingMessages, newMessage];
        }

        return {
          ...prevMessages,
          [key]: updatedMessages,
        };
      });

      return id;
    },
    [],
  );

  const removeMessage = useCallback(
    (key: string, messageId: string) => {
      if (!messages || !key || !messages[key]) return;
      setMessagesState((prevMessages) => ({
        ...prevMessages,
        [key]: prevMessages[key].filter((msg) => msg.id !== messageId),
      }));
    },
    [messages],
  );

  const clearMessages = useCallback((key: string) => {
    setMessagesState((prevMessages) => {
      const updatedMessages = { ...prevMessages };
      delete updatedMessages[key];
      return updatedMessages;
    });
  }, []);

  const value = useMemo(
    () => ({
      messages,
      addMessage,
      removeMessage,
      clearMessages,
    }),
    [messages, addMessage, removeMessage, clearMessages],
  );

  return (
    <StatusBarMessagesContext value={value}>
      {children}
    </StatusBarMessagesContext>
  );
}
